(function () {
    "use strict";

    const STATE = {
        userName: "",
        targetLang: "vi",
        userId: "",
        currentRoomId: null,
        currentRoomName: "",
        firebaseApp: null,
        db: null,
        messagesRef: null,
        usersRef: null,
        messagesListener: null,
        usersListener: null,
        isRecording: false,
        audioContext: null,
        mediaStream: null,
        scriptProcessor: null,
        userCount: 0,
        ttsQueue: [],
        ttsPlaying: false,
        renderedMessageKeys: new Set()
    };

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    function showView(viewId) {
        $$(".view").forEach((v) => v.classList.remove("active"));
        $(`#${viewId}`).classList.add("active");
    }

    function showToast(message, type) {
        type = type || "info";
        const container = $("#toast-container");
        const toast = document.createElement("div");
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 4000);
    }

    function formatTime(timestamp) {
        const date = new Date(timestamp);
        const h = date.getHours().toString().padStart(2, "0");
        const m = date.getMinutes().toString().padStart(2, "0");
        return `${h}:${m}`;
    }

    function getLangLabel(code) {
        const map = { vi: "VI", ja: "JA", en: "EN", ko: "KO", zh: "ZH" };
        return map[code] || code.toUpperCase();
    }

    function getVoiceForLang(lang) {
        const map = { vi: "vi-VN", ja: "ja-JP", en: "en-US" };
        return map[lang] || "en-US";
    }

    async function initFirebase() {
        try {
            const config = await window.pywebview.api.get_firebase_config();
            STATE.firebaseApp = firebase.initializeApp(config);
            STATE.db = firebase.database();
            STATE.userId = await window.pywebview.api.get_user_id();
        } catch (e) {
            showToast("Failed to initialize Firebase: " + e.message, "error");
        }
    }

    function setupSetupView() {
        const nameInput = $("#user-name-input");
        const langSelect = $("#target-lang-select");
        const continueBtn = $("#setup-continue-btn");

        nameInput.addEventListener("input", () => {
            continueBtn.disabled = nameInput.value.trim().length < 1;
        });

        continueBtn.addEventListener("click", async () => {
            STATE.userName = nameInput.value.trim();
            STATE.targetLang = langSelect.value;
            if (!STATE.userName) return;

            continueBtn.disabled = true;
            continueBtn.textContent = "Connecting...";

            await initFirebase();

            $("#lobby-user-badge").textContent =
                STATE.userName + " · " + getLangLabel(STATE.targetLang);
            await loadRooms();
            showView("lobby-view");
        });
    }

    async function loadRooms() {
        try {
            const rooms = await window.pywebview.api.get_rooms();
            const roomsList = $("#rooms-list");
            const emptyState = $("#empty-rooms");

            roomsList.innerHTML = "";

            if (!rooms || rooms.length === 0) {
                roomsList.style.display = "none";
                emptyState.style.display = "flex";
                return;
            }

            roomsList.style.display = "grid";
            emptyState.style.display = "none";

            rooms.forEach((room) => {
                const card = document.createElement("div");
                card.className = "room-card";
                card.dataset.roomId = room.id;
                card.dataset.isPrivate = room.isPrivate;

                const lockIcon = room.isPrivate
                    ? '<svg class="room-card-lock" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>'
                    : "";

                card.innerHTML =
                    '<div class="room-card-header">' +
                    '<span class="room-card-name">' +
                    escapeHtml(room.name) +
                    "</span>" +
                    lockIcon +
                    "</div>" +
                    '<div class="room-card-info">' +
                    '<span class="room-card-users"><span class="dot"></span>' +
                    room.userCount +
                    " online</span>" +
                    "</div>";

                card.addEventListener("click", () => handleJoinRoom(room));
                roomsList.appendChild(card);
            });
        } catch (e) {
            showToast("Failed to load rooms", "error");
        }
    }

    function handleJoinRoom(room) {
        if (room.isPrivate) {
            const modal = $("#join-password-modal");
            const input = $("#join-password-input");
            const error = $("#join-password-error");
            const confirmBtn = $("#confirm-join-btn");

            input.value = "";
            error.style.display = "none";
            modal.style.display = "flex";
            input.focus();

            STATE._pendingJoinRoom = room;
        } else {
            joinRoom(room.id, room.name);
        }
    }

    async function joinRoom(roomId, roomName) {
        try {
            await window.pywebview.api.join_room(
                roomId,
                STATE.userName,
                STATE.targetLang
            );
            STATE.currentRoomId = roomId;
            STATE.currentRoomName = roomName;

            $("#room-name-display").textContent = roomName;
            $("#chat-messages").innerHTML = "";
            STATE.renderedMessageKeys.clear();

            setupRoomListeners();
            setupPresence();
            showView("room-view");
            showToast("Joined room: " + roomName, "success");
        } catch (e) {
            showToast("Failed to join room: " + e.message, "error");
        }
    }

    function setupRoomListeners() {
        if (STATE.messagesListener) {
            STATE.messagesRef.off("child_added", STATE.messagesListener);
        }

        STATE.messagesRef = STATE.db.ref(
            "rooms/" + STATE.currentRoomId + "/messages"
        );

        STATE.messagesListener = STATE.messagesRef
            .orderByChild("timestamp")
            .limitToLast(100)
            .on("child_added", (snapshot) => {
                const key = snapshot.key;
                if (STATE.renderedMessageKeys.has(key)) return;
                STATE.renderedMessageKeys.add(key);

                const msg = snapshot.val();
                if (msg) renderMessage(msg);
            });
    }

    function setupPresence() {
        if (STATE.usersListener) {
            STATE.usersRef.off("value", STATE.usersListener);
        }

        STATE.usersRef = STATE.db.ref(
            "rooms/" + STATE.currentRoomId + "/users"
        );

        const myRef = STATE.usersRef.child(STATE.userId);
        myRef.onDisconnect().remove();
        myRef.set({
            name: STATE.userName,
            targetLang: STATE.targetLang,
            online: true,
            joinedAt: firebase.database.ServerValue.TIMESTAMP,
        });

        STATE.usersListener = STATE.usersRef.on("value", (snapshot) => {
            const users = snapshot.val();
            const count = users ? Object.keys(users).length : 0;
            STATE.userCount = count;
            $("#room-users-count").textContent = count + " online";

            window.pywebview.api.update_user_count(count);

            const micBtn = $("#mic-btn");
            const micStatus = $("#mic-status-text");
            const waitOverlay = $("#waiting-overlay");

            if (count < 2) {
                micBtn.disabled = true;
                micStatus.textContent = "Waiting for participants...";
                waitOverlay.style.display = "flex";
                if (STATE.isRecording) stopRecording();
            } else {
                micBtn.disabled = false;
                micStatus.textContent = "Hold to talk";
                waitOverlay.style.display = "none";
            }
        });
    }

    function renderMessage(msg) {
        const container = $("#chat-messages");
        const chatContainer = $("#chat-container");

        const isSelf = msg.sender === STATE.userName;
        const display = getDisplayTexts(msg, STATE.targetLang);

        const group = document.createElement("div");
        group.className = "message-group";

        const header = document.createElement("div");
        header.className = "message-header";

        const nameSpan = document.createElement("span");
        nameSpan.className = "sender-name" + (isSelf ? " self" : "");
        nameSpan.textContent = msg.sender;

        const timeSpan = document.createElement("span");
        timeSpan.className = "message-time";
        timeSpan.textContent = formatTime(msg.timestamp);

        header.appendChild(nameSpan);
        header.appendChild(timeSpan);

        if (msg.isTextOnly) {
            const badge = document.createElement("span");
            badge.className = "text-only-badge";
            badge.textContent = "TEXT";
            header.appendChild(badge);
        }

        group.appendChild(header);

        const mainDiv = document.createElement("div");
        mainDiv.className = "translated-text";
        mainDiv.textContent = display.mainText;
        group.appendChild(mainDiv);

        if (display.subtitleText && display.subtitleText !== display.mainText) {
            const subDiv = document.createElement("div");
            subDiv.className = "original-text";

            const langTag = document.createElement("span");
            langTag.className = "lang-tag";
            langTag.textContent = getLangLabel(display.subtitleLang);

            subDiv.appendChild(langTag);
            subDiv.appendChild(
                document.createTextNode(" " + display.subtitleText)
            );
            group.appendChild(subDiv);
        }

        container.appendChild(group);

        requestAnimationFrame(() => {
            chatContainer.scrollTop = chatContainer.scrollHeight;
        });

        if (!isSelf && !msg.isTextOnly && display.ttsText) {
            queueTTS(display.ttsText, display.ttsLang);
        }
    }

    function getDisplayTexts(msg, myTargetLang) {
        if (msg.isTextOnly) {
            return {
                mainText: msg.originalText,
                subtitleText: "",
                subtitleLang: "",
                ttsText: "",
                ttsLang: "",
            };
        }

        if (msg.translatedLang === myTargetLang) {
            return {
                mainText: msg.translatedText || msg.originalText,
                subtitleText: msg.originalText,
                subtitleLang: msg.originalLang,
                ttsText: msg.translatedText || msg.originalText,
                ttsLang: msg.translatedLang,
            };
        }

        if (msg.originalLang === myTargetLang) {
            return {
                mainText: msg.originalText,
                subtitleText: msg.translatedText,
                subtitleLang: msg.translatedLang,
                ttsText: msg.originalText,
                ttsLang: msg.originalLang,
            };
        }

        return {
            mainText: msg.translatedText || msg.originalText,
            subtitleText: msg.originalText,
            subtitleLang: msg.originalLang,
            ttsText: msg.translatedText || msg.originalText,
            ttsLang: msg.translatedLang || msg.originalLang,
        };
    }

    function queueTTS(text, lang) {
        STATE.ttsQueue.push({ text: text, lang: lang });
        if (!STATE.ttsPlaying) processTTSQueue();
    }

    async function processTTSQueue() {
        if (STATE.ttsQueue.length === 0) {
            STATE.ttsPlaying = false;
            return;
        }

        STATE.ttsPlaying = true;
        const item = STATE.ttsQueue.shift();

        try {
            const audioBase64 = await window.pywebview.api.generate_tts(
                item.text,
                item.lang
            );
            if (audioBase64) {
                const audio = new Audio(
                    "data:audio/mp3;base64," + audioBase64
                );
                audio.volume = 0.8;
                audio.onended = () => processTTSQueue();
                audio.onerror = () => processTTSQueue();
                await audio.play();
            } else {
                processTTSQueue();
            }
        } catch (e) {
            processTTSQueue();
        }
    }

    async function startRecording() {
        if (STATE.isRecording) return;

        try {
            const started = await window.pywebview.api.start_soniox_stream();
            if (!started) {
                showToast("Cannot start voice stream", "error");
                return;
            }

            STATE.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });

            STATE.audioContext = new AudioContext({ sampleRate: 16000 });
            const source = STATE.audioContext.createMediaStreamSource(
                STATE.mediaStream
            );
            STATE.scriptProcessor = STATE.audioContext.createScriptProcessor(
                4096,
                1,
                1
            );

            source.connect(STATE.scriptProcessor);
            STATE.scriptProcessor.connect(STATE.audioContext.destination);

            STATE.scriptProcessor.onaudioprocess = (e) => {
                if (!STATE.isRecording) return;
                const float32 = e.inputBuffer.getChannelData(0);
                const int16 = new Int16Array(float32.length);
                for (let i = 0; i < float32.length; i++) {
                    const s = Math.max(-1, Math.min(1, float32[i]));
                    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
                }
                const b64 = arrayBufferToBase64(int16.buffer);
                window.pywebview.api.send_audio_chunk(b64);
            };

            STATE.isRecording = true;
            const micBtn = $("#mic-btn");
            micBtn.classList.add("recording");
            micBtn.querySelector(".mic-icon").style.display = "none";
            micBtn.querySelector(".mic-off-icon").style.display = "block";
            $("#mic-status-text").textContent = "Recording...";
        } catch (e) {
            showToast("Microphone access denied", "error");
            await window.pywebview.api.stop_soniox_stream();
        }
    }

    async function stopRecording() {
        if (!STATE.isRecording) return;
        STATE.isRecording = false;

        if (STATE.scriptProcessor) {
            STATE.scriptProcessor.disconnect();
            STATE.scriptProcessor = null;
        }
        if (STATE.audioContext) {
            STATE.audioContext.close();
            STATE.audioContext = null;
        }
        if (STATE.mediaStream) {
            STATE.mediaStream.getTracks().forEach((t) => t.stop());
            STATE.mediaStream = null;
        }

        await window.pywebview.api.stop_soniox_stream();

        const micBtn = $("#mic-btn");
        micBtn.classList.remove("recording");
        micBtn.querySelector(".mic-icon").style.display = "block";
        micBtn.querySelector(".mic-off-icon").style.display = "none";
        $("#mic-status-text").textContent =
            STATE.userCount >= 2 ? "Hold to talk" : "Waiting for participants...";
    }

    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        let binary = "";
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    function escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    function setupLobbyView() {
        $("#create-room-btn").addEventListener("click", () => {
            $("#create-room-modal").style.display = "flex";
            $("#room-name-input").value = "";
            $("#room-private-check").checked = false;
            $("#room-password-group").style.display = "none";
            $("#room-password-input").value = "";
            $("#confirm-create-btn").disabled = true;
            $("#room-name-input").focus();
        });

        $("#close-modal-btn").addEventListener("click", () => {
            $("#create-room-modal").style.display = "none";
        });

        $("#cancel-create-btn").addEventListener("click", () => {
            $("#create-room-modal").style.display = "none";
        });

        $("#room-name-input").addEventListener("input", () => {
            $("#confirm-create-btn").disabled =
                $("#room-name-input").value.trim().length < 1;
        });

        $("#room-private-check").addEventListener("change", (e) => {
            $("#room-password-group").style.display = e.target.checked
                ? "flex"
                : "none";
        });

        $("#confirm-create-btn").addEventListener("click", async () => {
            const name = $("#room-name-input").value.trim();
            const isPrivate = $("#room-private-check").checked;
            const password = $("#room-password-input").value;

            if (!name) return;
            if (isPrivate && !password) {
                showToast("Please enter a password for private room", "error");
                return;
            }

            try {
                const roomId = await window.pywebview.api.create_room(
                    name,
                    isPrivate,
                    password
                );
                $("#create-room-modal").style.display = "none";
                showToast("Room created!", "success");
                await joinRoom(roomId, name);
            } catch (e) {
                showToast("Failed to create room", "error");
            }
        });

        $("#refresh-rooms-btn").addEventListener("click", () => {
            loadRooms();
        });

        $("#close-join-modal-btn").addEventListener("click", () => {
            $("#join-password-modal").style.display = "none";
        });

        $("#cancel-join-btn").addEventListener("click", () => {
            $("#join-password-modal").style.display = "none";
        });

        $("#confirm-join-btn").addEventListener("click", async () => {
            const room = STATE._pendingJoinRoom;
            if (!room) return;

            const password = $("#join-password-input").value;
            try {
                const valid = await window.pywebview.api.verify_room_password(
                    room.id,
                    password
                );
                if (valid) {
                    $("#join-password-modal").style.display = "none";
                    await joinRoom(room.id, room.name);
                } else {
                    $("#join-password-error").style.display = "block";
                }
            } catch (e) {
                showToast("Verification failed", "error");
            }
        });

        $("#join-password-input").addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                $("#confirm-join-btn").click();
            }
        });
    }

    function setupRoomView() {
        const micBtn = $("#mic-btn");
        let holdTimer = null;

        micBtn.addEventListener("mousedown", (e) => {
            if (micBtn.disabled) return;
            e.preventDefault();
            startRecording();
        });

        micBtn.addEventListener("mouseup", () => {
            stopRecording();
        });

        micBtn.addEventListener("mouseleave", () => {
            if (STATE.isRecording) stopRecording();
        });

        micBtn.addEventListener("touchstart", (e) => {
            if (micBtn.disabled) return;
            e.preventDefault();
            startRecording();
        });

        micBtn.addEventListener("touchend", (e) => {
            e.preventDefault();
            stopRecording();
        });

        $("#leave-room-btn").addEventListener("click", async () => {
            if (STATE.isRecording) await stopRecording();

            if (STATE.messagesListener && STATE.messagesRef) {
                STATE.messagesRef.off("child_added", STATE.messagesListener);
                STATE.messagesListener = null;
            }
            if (STATE.usersListener && STATE.usersRef) {
                STATE.usersRef.off("value", STATE.usersListener);
                STATE.usersListener = null;
            }

            const myRef = STATE.db.ref(
                "rooms/" +
                    STATE.currentRoomId +
                    "/users/" +
                    STATE.userId
            );
            myRef.remove();

            await window.pywebview.api.leave_room();
            STATE.currentRoomId = null;
            STATE.renderedMessageKeys.clear();
            STATE.ttsQueue = [];

            await loadRooms();
            showView("lobby-view");
            showToast("Left room", "info");
        });

        const textInput = $("#text-message-input");
        const sendBtn = $("#send-text-btn");

        async function sendTextMessage() {
            const text = textInput.value.trim();
            if (!text || !STATE.currentRoomId) return;
            textInput.value = "";

            try {
                await window.pywebview.api.send_text_message(
                    STATE.currentRoomId,
                    STATE.userName,
                    text,
                    STATE.targetLang
                );
            } catch (e) {
                showToast("Failed to send message", "error");
            }
        }

        sendBtn.addEventListener("click", sendTextMessage);
        textInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendTextMessage();
            }
        });
    }

    function setupPythonEvents() {
        window.addEventListener("pythonEvent", (e) => {
            const detail = e.detail;
            const type = detail.type;
            const data = detail.data;

            if (type === "soniox_connected") {
                updateSonioxStatus("connected");
            } else if (type === "soniox_disconnected") {
                updateSonioxStatus("disconnected");
            } else if (type === "soniox_error") {
                updateSonioxStatus("error");
                showToast("Soniox: " + (data.message || data.code), "error");
            } else if (type === "idle_timeout") {
                updateSonioxStatus("disconnected");
                showToast(
                    data.message || "Connection closed due to inactivity",
                    "error"
                );
            } else if (type === "mic_disabled") {
                showToast(
                    data.message || "Mic disabled",
                    "info"
                );
            }
        });
    }

    function updateSonioxStatus(status) {
        const dot = $("#soniox-status .status-dot");
        const text = $("#soniox-status .status-text");

        dot.className = "status-dot";

        if (status === "connected") {
            dot.classList.add("connected");
            text.textContent = "Connected";
        } else if (status === "error") {
            dot.classList.add("error");
            text.textContent = "Error";
        } else {
            text.textContent = "Disconnected";
        }
    }

    function init() {
        setupSetupView();
        setupLobbyView();
        setupRoomView();
        setupPythonEvents();
    }

    if (window.pywebview) {
        init();
    } else {
        window.addEventListener("pywebviewready", init);
    }
})();
