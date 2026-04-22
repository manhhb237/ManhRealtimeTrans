import webview
import json
import os
import time
import base64
import asyncio
import threading
import tempfile
import uuid
import queue
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, db as firebase_db
from websockets.sync.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed
import edge_tts
import bcrypt

SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket"
BASE_DIR = Path(__file__).parent


class ChatAPI:
    def __init__(self):
        self.config = self._load_config()
        self._init_firebase()
        self.window = None
        self.soniox_ws = None
        self.soniox_running = False
        self.current_room_id = None
        self.current_user_id = str(uuid.uuid4())
        self.idle_timer = time.time()
        self.user_count = 0
        self.original_buffer = []
        self.translated_buffer = []
        self.current_sender = ""
        self.current_target_lang = ""
        self.audio_queue = queue.Queue()
        self._soniox_lock = threading.Lock()

    def _load_config(self):
        config_path = BASE_DIR / "config.json"
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)

    def _init_firebase(self):
        try:
            firebase_admin.get_app()
        except ValueError:
            sa_path = self.config["firebase_service_account"]
            if not os.path.isabs(sa_path):
                sa_path = str(BASE_DIR / sa_path)
            cred = credentials.Certificate(sa_path)
            firebase_admin.initialize_app(cred, {
                "databaseURL": self.config["firebase_config"]["databaseURL"]
            })

    def get_firebase_config(self):
        return self.config["firebase_config"]

    def get_user_id(self):
        return self.current_user_id

    def get_rooms(self):
        ref = firebase_db.reference("/rooms")
        rooms = ref.get()
        if not rooms:
            return []
        result = []
        for room_id, room_data in rooms.items():
            if isinstance(room_data, dict):
                users = room_data.get("users", {})
                if isinstance(users, dict):
                    online_count = sum(
                        1 for u in users.values()
                        if isinstance(u, dict) and u.get("online")
                    )
                else:
                    online_count = 0
                result.append({
                    "id": room_id,
                    "name": room_data.get("name", ""),
                    "isPrivate": room_data.get("isPrivate", False),
                    "userCount": online_count,
                    "createdAt": room_data.get("createdAt", 0)
                })
        return result

    def create_room(self, name, is_private, password):
        room_id = str(uuid.uuid4())[:8]
        room_data = {
            "name": name,
            "isPrivate": is_private,
            "createdAt": int(time.time() * 1000),
            "createdBy": self.current_user_id
        }
        if is_private and password:
            room_data["passwordHash"] = bcrypt.hashpw(
                password.encode(), bcrypt.gensalt()
            ).decode()
        ref = firebase_db.reference(f"/rooms/{room_id}")
        ref.set(room_data)
        return room_id

    def verify_room_password(self, room_id, password):
        ref = firebase_db.reference(f"/rooms/{room_id}")
        room = ref.get()
        if not room:
            return False
        if not room.get("isPrivate"):
            return True
        stored_hash = room.get("passwordHash", "")
        try:
            return bcrypt.checkpw(password.encode(), stored_hash.encode())
        except Exception:
            return False

    def join_room(self, room_id, user_name, target_lang):
        self.current_room_id = room_id
        self.current_sender = user_name
        self.current_target_lang = target_lang
        user_ref = firebase_db.reference(
            f"/rooms/{room_id}/users/{self.current_user_id}"
        )
        user_ref.set({
            "name": user_name,
            "targetLang": target_lang,
            "online": True,
            "joinedAt": int(time.time() * 1000)
        })
        return True

    def leave_room(self):
        if self.current_room_id:
            self.stop_soniox_stream()
            user_ref = firebase_db.reference(
                f"/rooms/{self.current_room_id}/users/{self.current_user_id}"
            )
            try:
                user_ref.delete()
            except Exception:
                pass
            self.current_room_id = None

    def send_text_message(self, room_id, sender, text, lang):
        msg = {
            "sender": sender,
            "originalLang": lang,
            "originalText": text,
            "translatedText": "",
            "translatedLang": "",
            "isTextOnly": True,
            "timestamp": int(time.time() * 1000)
        }
        ref = firebase_db.reference(f"/rooms/{room_id}/messages")
        ref.push(msg)
        return True

    def start_soniox_stream(self):
        if self.soniox_running:
            return False
        if self.user_count < 2:
            return False
        self.soniox_running = True
        self.idle_timer = time.time()
        self.original_buffer = []
        self.translated_buffer = []
        while not self.audio_queue.empty():
            try:
                self.audio_queue.get_nowait()
            except queue.Empty:
                break
        t = threading.Thread(target=self._soniox_receive_loop, daemon=True)
        t.start()
        return True

    def stop_soniox_stream(self):
        self.soniox_running = False
        if self.original_buffer or self.translated_buffer:
            self._flush_to_firebase()

    def send_audio_chunk(self, base64_data):
        if self.soniox_running:
            self.audio_queue.put(base64_data)
            self.idle_timer = time.time()
            return True
        return False

    def _soniox_send_loop(self, ws):
        while self.soniox_running:
            try:
                data = self.audio_queue.get(timeout=0.1)
                audio_bytes = base64.b64decode(data)
                ws.send(audio_bytes)
            except queue.Empty:
                continue
            except Exception:
                break
        try:
            ws.send("")
        except Exception:
            pass

    def _soniox_receive_loop(self):
        ws = None
        try:
            config = {
                "api_key": self.config["soniox_api_key"],
                "model": "stt-rt-v4",
                "audio_format": "pcm_s16le",
                "sample_rate": 16000,
                "num_channels": 1,
                "language_hints": ["vi", "ja"],
                "enable_language_identification": True,
                "enable_endpoint_detection": True,
                "translation": {
                    "type": "two_way",
                    "language_a": "vi",
                    "language_b": "ja"
                }
            }

            ws = ws_connect(SONIOX_WS_URL)
            self.soniox_ws = ws
            ws.send(json.dumps(config))

            sender_thread = threading.Thread(
                target=self._soniox_send_loop, args=(ws,), daemon=True
            )
            sender_thread.start()

            self._notify_ui("soniox_connected", {})

            while self.soniox_running:
                if time.time() - self.idle_timer > 1800:
                    self._notify_ui("idle_timeout", {
                        "message": "30 minutes idle. Connection closed."
                    })
                    break

                try:
                    message = ws.recv(timeout=2.0)
                except TimeoutError:
                    if self.original_buffer and self.translated_buffer:
                        self._flush_to_firebase()
                    continue
                except ConnectionClosed:
                    break
                except Exception:
                    continue

                res = json.loads(message)

                if res.get("error_code"):
                    self._notify_ui("soniox_error", {
                        "code": res["error_code"],
                        "message": res.get("error_message", "")
                    })
                    break

                has_new_final = False
                for token in res.get("tokens", []):
                    if not token.get("text"):
                        continue
                    if token.get("is_final"):
                        has_new_final = True
                        self.idle_timer = time.time()
                        ts = token.get("translation_status", "")
                        if ts == "translation":
                            self.translated_buffer.append(token)
                        else:
                            self.original_buffer.append(token)

                if has_new_final and self._should_flush():
                    self._flush_to_firebase()

                if res.get("finished"):
                    if self.original_buffer:
                        self._flush_to_firebase()
                    break

        except Exception as e:
            self._notify_ui("soniox_error", {
                "code": "connection_error",
                "message": str(e)
            })
        finally:
            self.soniox_running = False
            if ws:
                try:
                    ws.close()
                except Exception:
                    pass
            self.soniox_ws = None
            self._notify_ui("soniox_disconnected", {})

    def _should_flush(self):
        if not self.original_buffer:
            return False
        orig_text = "".join(t["text"] for t in self.original_buffer).strip()
        if not orig_text:
            return False
        punct = set(".?!。？！…\n")
        if orig_text[-1] in punct:
            return True
        if len(orig_text) > 50:
            return True
        if self.translated_buffer:
            trans_text = "".join(t["text"] for t in self.translated_buffer).strip()
            if trans_text and trans_text[-1] in punct:
                return True
        return False

    def _flush_to_firebase(self):
        if not self.original_buffer:
            return

        orig_text = "".join(t["text"] for t in self.original_buffer).strip()
        trans_text = "".join(t["text"] for t in self.translated_buffer).strip()

        if not orig_text:
            self.original_buffer = []
            self.translated_buffer = []
            return

        orig_lang = "vi"
        trans_lang = "ja"
        if self.original_buffer:
            detected = self.original_buffer[0].get("language", "vi")
            if detected in ("vi", "ja"):
                orig_lang = detected
                trans_lang = "ja" if detected == "vi" else "vi"

        msg = {
            "sender": self.current_sender,
            "originalLang": orig_lang,
            "originalText": orig_text,
            "translatedText": trans_text if trans_text else orig_text,
            "translatedLang": trans_lang,
            "timestamp": int(time.time() * 1000)
        }

        self.original_buffer = []
        self.translated_buffer = []

        if self.current_room_id:
            try:
                ref = firebase_db.reference(
                    f"/rooms/{self.current_room_id}/messages"
                )
                ref.push(msg)
            except Exception:
                pass

    def generate_tts(self, text, lang):
        voice_map = {
            "vi": "vi-VN-HoaiMyNeural",
            "ja": "ja-JP-NanamiNeural",
            "en": "en-US-JennyNeural",
            "ko": "ko-KR-SunHiNeural",
            "zh": "zh-CN-XiaoxiaoNeural"
        }
        voice = voice_map.get(lang, "en-US-JennyNeural")
        tmp_file = os.path.join(
            tempfile.gettempdir(), f"tts_{uuid.uuid4().hex}.mp3"
        )

        async def _gen():
            communicate = edge_tts.Communicate(text, voice)
            await communicate.save(tmp_file)

        asyncio.run(_gen())

        with open(tmp_file, "rb") as f:
            audio_data = f.read()

        try:
            os.remove(tmp_file)
        except Exception:
            pass

        return base64.b64encode(audio_data).decode()

    def update_user_count(self, count):
        self.user_count = count
        if count < 2 and self.soniox_running:
            self.stop_soniox_stream()
            self._notify_ui("mic_disabled", {
                "message": "Waiting for more participants..."
            })

    def _notify_ui(self, event_type, data):
        if self.window:
            try:
                js_data = json.dumps(data)
                js_code = (
                    f"window.dispatchEvent(new CustomEvent('pythonEvent', "
                    f"{{detail: {{type: '{event_type}', data: {js_data}}}}}));"
                )
                self.window.evaluate_js(js_code)
            except Exception:
                pass

    def delete_room(self, room_id):
        try:
            ref = firebase_db.reference(f"/rooms/{room_id}")
            ref.delete()
            return True
        except Exception:
            return False


def main():
    api = ChatAPI()

    window = webview.create_window(
        "Manh's Realtime Translator",
        url=str(BASE_DIR / "public" / "index.html"),
        js_api=api,
        width=1200,
        height=800,
        min_size=(800, 600)
    )

    api.window = window
    webview.start(debug=False)


if __name__ == "__main__":
    main()
