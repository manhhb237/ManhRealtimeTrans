(function () {
    "use strict";

    var SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
    var LS_PREFIX = "manh_rt_";

    var STATE = {
        userName: "",
        targetLang: "vi",
        ttsSpeed: "+20%",
        sonioxApiKey: "",
        userId: "",
        currentRoomId: null,
        currentRoomName: "",
        db: null,
        sonioxWs: null,
        sonioxReady: false,
        isRecording: false,
        audioContext: null,
        mediaStream: null,
        sourceNode: null,
        scriptProcessor: null,
        originalBuffer: [],
        translatedBuffer: [],
        lastTokenTime: 0,
        flushTimer: null,
        idleTimer: 0,
        idleCheckInterval: null,
        keepaliveInterval: null,
        userCount: 0,
        ttsQueue: [],
        ttsPlaying: false,
        ttsInitialized: false,
        audioUnlocked: false,
        ttsAudioContext: null,
        ttsAudioElement: null,
        ttsAudioElementReady: false,
        renderedMessageKeys: new Set(),
        messagesRef: null,
        usersRef: null,
        pendingJoinRoom: null,
        joinedAtTime: 0,
        messageHistory: [],
        sessionRefreshInterval: null,
        sonioxSessionStart: 0,
        soloMode: false,
        detectedOriginalLang: null
    };

    var $ = function (sel) { return document.querySelector(sel); };

    function generateId() {
        return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    }

    function saveSettings() {
        try {
            localStorage.setItem(LS_PREFIX + "username", STATE.userName);
            localStorage.setItem(LS_PREFIX + "targetlang", STATE.targetLang);
            localStorage.setItem(LS_PREFIX + "ttsspeed", STATE.ttsSpeed);
            localStorage.setItem(LS_PREFIX + "soniox_key", STATE.sonioxApiKey);
            localStorage.setItem(LS_PREFIX + "userid", STATE.userId);
        } catch (e) {}
    }

    function loadSettings() {
        try {
            STATE.userName = localStorage.getItem(LS_PREFIX + "username") || "";
            STATE.targetLang = localStorage.getItem(LS_PREFIX + "targetlang") || "vi";
            STATE.ttsSpeed = localStorage.getItem(LS_PREFIX + "ttsspeed") || "+20%";
            STATE.sonioxApiKey = localStorage.getItem(LS_PREFIX + "soniox_key") || "";
            STATE.userId = localStorage.getItem(LS_PREFIX + "userid") || generateId();
            if (!localStorage.getItem(LS_PREFIX + "userid")) {
                localStorage.setItem(LS_PREFIX + "userid", STATE.userId);
            }
        } catch (e) {
            STATE.userId = generateId();
        }
    }

    function showView(viewId) {
        document.querySelectorAll(".view").forEach(function (v) {
            v.classList.remove("active");
        });
        var el = $("#" + viewId);
        if (el) el.classList.add("active");
    }

    function showToast(message, type) {
        type = type || "info";
        var container = $("#toast-container");
        var toast = document.createElement("div");
        toast.className = "toast " + type;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(function () {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 4000);
    }

    function formatTime(timestamp) {
        var d = new Date(timestamp);
        return (
            d.getHours().toString().padStart(2, "0") +
            ":" +
            d.getMinutes().toString().padStart(2, "0")
        );
    }

    function getLangLabel(code) {
        var map = { vi: "VI", ja: "JA", en: "EN", ko: "KO", zh: "ZH" };
        return map[code] || (code || "").toUpperCase();
    }

    function nameToColor(name) {
        var colors = [
            '#a855f7', '#3b82f6', '#ef4444', '#f59e0b',
            '#22c55e', '#ec4899', '#14b8a6', '#f97316',
            '#8b5cf6', '#06b6d4', '#e879f9', '#84cc16'
        ];
        var hash = 0;
        for (var i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        return colors[Math.abs(hash) % colors.length];
    }

    function escapeHtml(text) {
        var div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    async function hashPassword(password) {
        var data = new TextEncoder().encode(password);
        var hash = await crypto.subtle.digest("SHA-256", data);
        return Array.from(new Uint8Array(hash))
            .map(function (b) { return b.toString(16).padStart(2, "0"); })
            .join("");
    }

    function initFirebase() {
        if (typeof FIREBASE_CONFIG === "undefined" || !FIREBASE_CONFIG.apiKey) {
            showToast("Firebase config missing. Edit config.js before deploying.", "error");
            return false;
        }
        try {
            if (!firebase.apps.length) {
                firebase.initializeApp(FIREBASE_CONFIG);
            }
            STATE.db = firebase.database();
            return true;
        } catch (e) {
            showToast("Firebase init failed: " + e.message, "error");
            return false;
        }
    }

    function initTTS() {
        STATE.ttsInitialized = true;
        // Create the persistent audio element if not yet created
        if (!STATE.ttsAudioElement) {
            var audio = document.createElement('audio');
            audio.id = 'tts-persistent-audio';
            audio.setAttribute('playsinline', '');
            audio.setAttribute('webkit-playsinline', '');
            audio.preload = 'auto';
            // iOS needs the element in the DOM
            audio.style.position = 'absolute';
            audio.style.left = '-9999px';
            audio.style.top = '-9999px';
            audio.style.width = '1px';
            audio.style.height = '1px';
            document.body.appendChild(audio);
            STATE.ttsAudioElement = audio;
            console.log('[TTS] Persistent audio element created');
        }
    }

    // Ensure TTS AudioContext exists and is resumed (for Web Audio API playback)
    function ensureTTSContext() {
        if (!STATE.ttsAudioContext || STATE.ttsAudioContext.state === 'closed') {
            STATE.ttsAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (STATE.ttsAudioContext.state === 'suspended') {
            STATE.ttsAudioContext.resume();
        }
        return STATE.ttsAudioContext;
    }

    // Prime the persistent audio element with a silent clip so iOS allows future .play() calls.
    // This MUST be called inside a direct user gesture handler (touchstart/mousedown/click).
    function unlockAudioContext() {
        // 1) Unlock Web Audio API context
        try {
            var ctx = ensureTTSContext();
            var buf = ctx.createBuffer(1, 1, 22050);
            var src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start(0);
        } catch (e) {
            console.warn('[TTS] AudioContext unlock failed:', e);
        }

        // 2) Prime the persistent HTML5 Audio element (critical for iOS)
        if (STATE.ttsAudioElement && !STATE.ttsAudioElementReady) {
            try {
                // Create a tiny silent WAV (44 bytes header + 2 bytes of silence)
                var silentWav = createSilentWav();
                var silentUrl = URL.createObjectURL(silentWav);
                STATE.ttsAudioElement.src = silentUrl;
                var playPromise = STATE.ttsAudioElement.play();
                if (playPromise && playPromise.then) {
                    playPromise.then(function () {
                        STATE.ttsAudioElementReady = true;
                        STATE.audioUnlocked = true;
                        console.log('[TTS] iOS audio element primed successfully');
                        setTimeout(function () { URL.revokeObjectURL(silentUrl); }, 1000);
                    }).catch(function (e) {
                        console.warn('[TTS] iOS audio prime failed:', e);
                        setTimeout(function () { URL.revokeObjectURL(silentUrl); }, 1000);
                    });
                } else {
                    STATE.ttsAudioElementReady = true;
                    STATE.audioUnlocked = true;
                    setTimeout(function () { URL.revokeObjectURL(silentUrl); }, 1000);
                }
            } catch (e) {
                console.warn('[TTS] Audio element prime error:', e);
            }
        } else if (STATE.ttsAudioElementReady) {
            STATE.audioUnlocked = true;
        }

        if (STATE.audioUnlocked) {
            console.log('[TTS] Audio fully unlocked');
        }
    }

    // Generate a minimal silent WAV file (for iOS audio priming)
    function createSilentWav() {
        var sampleRate = 22050;
        var numSamples = 1;
        var buffer = new ArrayBuffer(44 + numSamples * 2);
        var view = new DataView(buffer);
        // RIFF header
        writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + numSamples * 2, true);
        writeString(view, 8, 'WAVE');
        // fmt subchunk
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, 1, true); // mono
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        // data subchunk
        writeString(view, 36, 'data');
        view.setUint32(40, numSamples * 2, true);
        view.setInt16(44, 0, true); // silence
        return new Blob([buffer], { type: 'audio/wav' });
    }

    function writeString(view, offset, string) {
        for (var i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    function generateTTSId() {
        var hex = '';
        for (var i = 0; i < 32; i++) {
            hex += Math.floor(Math.random() * 16).toString(16);
        }
        return hex;
    }

    function escapeXml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function fetchEdgeTTSAudio(text, lang) {
        return new Promise(function (resolve, reject) {
            var voiceMap = {
                vi: 'vi-VN-HoaiMyNeural',
                ja: 'ja-JP-NanamiNeural',
                en: 'en-US-AriaNeural',
                ko: 'ko-KR-SunHiNeural',
                zh: 'zh-CN-XiaoxiaoNeural'
            };
            var voice = voiceMap[lang] || voiceMap['vi'];
            var langMap = { vi: 'vi-VN', ja: 'ja-JP', en: 'en-US', ko: 'ko-KR', zh: 'zh-CN' };
            var xmlLang = langMap[lang] || 'vi-VN';
            var connId = generateTTSId();
            var token = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
            var url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' + token + '&ConnectionId=' + connId;

            var ws;
            var audioChunks = [];
            var timeout = setTimeout(function () {
                try { ws.close(); } catch (e) {}
                reject(new Error('timeout'));
            }, 10000);

            try {
                ws = new WebSocket(url);
            } catch (e) {
                clearTimeout(timeout);
                reject(e);
                return;
            }

            ws.onopen = function () {
                var configMsg = 'Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' +
                    JSON.stringify({
                        context: {
                            synthesis: {
                                audio: {
                                    metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
                                    outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
                                }
                            }
                        }
                    });
                ws.send(configMsg);

                var requestId = generateTTSId();
                var ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="' + xmlLang + '">' +
                    '<voice name="' + voice + '">' +
                    '<prosody pitch="+0Hz" rate="' + STATE.ttsSpeed + '">' + escapeXml(text) + '</prosody>' +
                    '</voice></speak>';
                var ssmlMsg = 'X-RequestId:' + requestId + '\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n' + ssml;
                ws.send(ssmlMsg);
            };

            ws.onmessage = function (event) {
                if (event.data instanceof Blob) {
                    event.data.arrayBuffer().then(function (buffer) {
                        var view = new DataView(buffer);
                        if (buffer.byteLength < 2) return;
                        var headerLen = view.getInt16(0);
                        var audioData = buffer.slice(2 + headerLen);
                        if (audioData.byteLength > 0) {
                            audioChunks.push(audioData);
                        }
                    });
                } else if (typeof event.data === 'string') {
                    if (event.data.indexOf('Path:turn.end') !== -1) {
                        clearTimeout(timeout);
                        ws.close();
                        if (audioChunks.length > 0) {
                            resolve(new Blob(audioChunks, { type: 'audio/mp3' }));
                        } else {
                            resolve(null);
                        }
                    }
                }
            };

            ws.onerror = function () {
                clearTimeout(timeout);
                reject(new Error('ws_error'));
            };
        });
    }

    function playAudioBlob(blob) {
        return new Promise(function (resolve, reject) {
            if (!blob) { resolve(); return; }

            // Strategy: Use the persistent audio element (best for iOS)
            // Fallback: Web Audio API, then new Audio()
            var audioUrl = URL.createObjectURL(blob);

            function cleanupUrl() {
                setTimeout(function () { URL.revokeObjectURL(audioUrl); }, 500);
            }

            // Method 1: Persistent <audio> element (primed on user gesture — works on iOS)
            if (STATE.ttsAudioElement && STATE.ttsAudioElementReady) {
                var el = STATE.ttsAudioElement;
                var onEnded, onError;

                onEnded = function () {
                    el.removeEventListener('ended', onEnded);
                    el.removeEventListener('error', onError);
                    cleanupUrl();
                    resolve();
                };
                onError = function (e) {
                    el.removeEventListener('ended', onEnded);
                    el.removeEventListener('error', onError);
                    console.warn('[TTS] Persistent audio element error, trying fallback:', e);
                    cleanupUrl();
                    playAudioBlobFallback(blob).then(resolve).catch(reject);
                };

                el.addEventListener('ended', onEnded);
                el.addEventListener('error', onError);
                el.src = audioUrl;
                el.currentTime = 0;

                var playPromise = el.play();
                if (playPromise && playPromise.catch) {
                    playPromise.catch(function (e) {
                        el.removeEventListener('ended', onEnded);
                        el.removeEventListener('error', onError);
                        console.warn('[TTS] Persistent element play() failed:', e);
                        cleanupUrl();
                        playAudioBlobFallback(blob).then(resolve).catch(reject);
                    });
                }
                return;
            }

            // Not primed yet — go straight to fallback
            console.warn('[TTS] Audio element not primed, using fallback');
            cleanupUrl();
            playAudioBlobFallback(blob).then(resolve).catch(reject);
        });
    }

    // Fallback: Web Audio API decoding → new Audio() element
    function playAudioBlobFallback(blob) {
        return new Promise(function (resolve, reject) {
            if (!blob) { resolve(); return; }

            // Try Web Audio API
            try {
                var ctx = ensureTTSContext();
                blob.arrayBuffer().then(function (arrayBuffer) {
                    return ctx.decodeAudioData(arrayBuffer);
                }).then(function (audioBuffer) {
                    var source = ctx.createBufferSource();
                    source.buffer = audioBuffer;
                    source.connect(ctx.destination);
                    source.onended = function () { resolve(); };
                    source.start(0);
                }).catch(function (err) {
                    console.warn('[TTS] Web Audio fallback failed, trying new Audio():', err);
                    var audioUrl = URL.createObjectURL(blob);
                    var audio = new Audio(audioUrl);
                    audio.setAttribute('playsinline', '');
                    audio.onended = function () { URL.revokeObjectURL(audioUrl); resolve(); };
                    audio.onerror = function () { URL.revokeObjectURL(audioUrl); reject(); };
                    audio.play().catch(function (e) {
                        URL.revokeObjectURL(audioUrl);
                        reject(e);
                    });
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    function fallbackWebSpeech(text, lang) {
        return new Promise(function (resolve) {
            if (!window.speechSynthesis) { resolve(); return; }
            var u = new SpeechSynthesisUtterance(text);
            u.lang = lang === 'vi' ? 'vi-VN' : 'ja-JP';
            u.rate = 0.95;
            u.onend = function () { resolve(); };
            u.onerror = function () { resolve(); };
            speechSynthesis.speak(u);
        });
    }

    async function loadRooms() {
        try {
            var snap = await STATE.db.ref("rooms").once("value");
            var rooms = snap.val();
            var roomsList = $("#rooms-list");
            var emptyState = $("#empty-rooms");
            roomsList.innerHTML = "";

            if (!rooms || Object.keys(rooms).length === 0) {
                roomsList.style.display = "none";
                emptyState.style.display = "flex";
                return;
            }

            roomsList.style.display = "grid";
            emptyState.style.display = "none";

            Object.keys(rooms).forEach(function (roomId) {
                var r = rooms[roomId];
                if (typeof r !== "object" || r === null) return;
                var users = r.users || {};
                var count = 0;
                Object.keys(users).forEach(function (k) {
                    if (users[k] && users[k].online) count++;
                });

                var card = document.createElement("div");
                card.className = "room-card";

                var lockIcon = r.isPrivate
                    ? '<svg class="room-card-lock" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>'
                    : "";

                card.innerHTML =
                    '<div class="room-card-header"><span class="room-card-name">' +
                    escapeHtml(r.name || "Unnamed") +
                    '</span><span class="room-card-actions">' + lockIcon +
                    '<button class="btn-delete-room" title="Delete room"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>' +
                    '</span></div>' +
                    '<div class="room-card-info"><span class="room-card-users"><span class="dot"></span>' +
                    count + ' online</span></div>';

                card.querySelector('.btn-delete-room').addEventListener('click', function (e) {
                    e.stopPropagation();
                    handleDeleteRoom({ id: roomId, name: r.name, isPrivate: r.isPrivate });
                });

                card.addEventListener("click", function () {
                    handleJoinRoom({ id: roomId, name: r.name, isPrivate: r.isPrivate });
                });
                roomsList.appendChild(card);
            });
        } catch (e) {
            showToast("Failed to load rooms", "error");
        }
    }

    async function createRoom(name, isPrivate, password) {
        var roomId = generateId().substring(0, 8);
        var data = {
            name: name,
            isPrivate: isPrivate,
            createdAt: firebase.database.ServerValue.TIMESTAMP,
            createdBy: STATE.userId
        };
        if (isPrivate && password) {
            data.passwordHash = await hashPassword(password);
        }
        await STATE.db.ref("rooms/" + roomId).set(data);
        return roomId;
    }

    function handleJoinRoom(room) {
        if (room.isPrivate) {
            STATE.pendingJoinRoom = room;
            STATE.passwordAction = 'join';
            $("#join-password-modal-title").textContent = 'Enter Room Password';
            $("#confirm-join-btn").textContent = 'Join Room';
            $("#join-password-input").value = "";
            $("#join-password-error").style.display = "none";
            $("#join-password-modal").style.display = "flex";
            $("#join-password-input").focus();
        } else {
            joinRoom(room.id, room.name);
        }
    }

    function handleDeleteRoom(room) {
        if (room.isPrivate) {
            STATE.pendingJoinRoom = room;
            STATE.passwordAction = 'delete';
            $("#join-password-modal-title").textContent = 'Enter Password to Delete';
            $("#confirm-join-btn").textContent = 'Delete Room';
            $("#join-password-input").value = "";
            $("#join-password-error").style.display = "none";
            $("#join-password-modal").style.display = "flex";
            $("#join-password-input").focus();
        } else {
            if (confirm('Delete room "' + room.name + '"?')) {
                deleteRoom(room.id);
            }
        }
    }

    async function deleteRoom(roomId) {
        try {
            await STATE.db.ref('rooms/' + roomId).remove();
            showToast('Room deleted', 'success');
            loadRooms();
        } catch (e) {
            showToast('Failed to delete room', 'error');
        }
    }

    async function joinRoom(roomId, roomName) {
        STATE.currentRoomId = roomId;
        STATE.currentRoomName = roomName;

        var userRef = STATE.db.ref("rooms/" + roomId + "/users/" + STATE.userId);
        await userRef.set({
            name: STATE.userName,
            targetLang: STATE.targetLang,
            online: true,
            joinedAt: firebase.database.ServerValue.TIMESTAMP
        });
        userRef.onDisconnect().remove();

        $("#room-name-display").textContent = roomName;
        $("#chat-messages").innerHTML = "";
        STATE.renderedMessageKeys.clear();
        STATE.joinedAtTime = Date.now();

        initTTS();
        unlockAudioContext();
        setupRoomListeners();
        showView("room-view");
        showToast("Joined: " + roomName, "success");
    }

    function setupRoomListeners() {
        cleanupRoomListeners();

        STATE.messagesRef = STATE.db.ref("rooms/" + STATE.currentRoomId + "/messages");
        STATE.messagesRef
            .orderByChild("timestamp")
            .limitToLast(100)
            .on("child_added", function (snap) {
                var key = snap.key;
                if (STATE.renderedMessageKeys.has(key)) return;
                STATE.renderedMessageKeys.add(key);
                var msg = snap.val();
                if (msg) renderMessage(msg);
            });

        STATE.usersRef = STATE.db.ref("rooms/" + STATE.currentRoomId + "/users");
        STATE.usersRef.on("value", function (snap) {
            var users = snap.val();
            var count = users ? Object.keys(users).length : 0;
            STATE.userCount = count;
            $("#room-users-count").textContent = count + " online";

            var micBtn = $("#mic-btn");
            var micStatus = $("#mic-status-text");
            var waitOverlay = $("#waiting-overlay");

            if (count === 1) {
                // Solo listening mode
                STATE.soloMode = true;
                micBtn.disabled = false;
                waitOverlay.style.display = "none";
                if (!STATE.isRecording) {
                    micStatus.textContent = "Tap to start listening";
                }
            } else if (count >= 2) {
                STATE.soloMode = false;
                micBtn.disabled = false;
                micStatus.textContent = STATE.isRecording ? "Recording..." : "Hold to talk";
                waitOverlay.style.display = "none";
            } else {
                STATE.soloMode = false;
                micBtn.disabled = true;
                micStatus.textContent = "Waiting for participants...";
                waitOverlay.style.display = "flex";
                if (STATE.isRecording) stopRecording();
                disconnectSoniox();
            }
        });
    }

    function cleanupRoomListeners() {
        if (STATE.messagesRef) {
            STATE.messagesRef.off();
            STATE.messagesRef = null;
        }
        if (STATE.usersRef) {
            STATE.usersRef.off();
            STATE.usersRef = null;
        }
    }

    function buildSonioxContext() {
        var recentMsgs = STATE.messageHistory.slice(-3);
        if (recentMsgs.length === 0) return undefined;
        var contextParts = [];
        recentMsgs.forEach(function (m) {
            if (m.originalText) contextParts.push(m.originalText);
            if (m.translatedText) contextParts.push(m.translatedText);
        });
        var contextText = contextParts.join(' ').substring(0, 2000);
        if (!contextText) return undefined;
        return {
            text: contextText
        };
    }

    function connectSoniox() {
        if (STATE.sonioxWs && STATE.sonioxWs.readyState === WebSocket.OPEN) return;
        if (!STATE.sonioxApiKey) {
            showToast("Soniox API key not set", "error");
            return;
        }

        try {
            var ws = new WebSocket(SONIOX_WS_URL);
            STATE.sonioxWs = ws;
            STATE.sonioxReady = false;

            ws.onopen = function () {
                var myLang = STATE.targetLang || "vi";
                // Determine the "other" language based on what users are in the room
                // For vi↔ja use case, simply pick the opposite; extend for more languages
                var supportedLangs = ["vi", "ja", "en", "ko", "zh"];
                var theirLang = myLang === "vi" ? "ja" : myLang === "ja" ? "vi" : "en";

                var config;
                if (STATE.soloMode) {
                    // Solo listening mode: detect any language, translate both ways
                    // Use the user's target language as one side of two_way translation
                    var langA = myLang;
                    var langB = theirLang;
                    config = {
                        api_key: STATE.sonioxApiKey,
                        model: "stt-rt-v4",
                        audio_format: "pcm_s16le",
                        sample_rate: 16000,
                        num_channels: 1,
                        language_hints: [langA, langB],
                        enable_language_identification: true,
                        enable_endpoint_detection: true,
                        max_endpoint_delay_ms: 2500,
                        translation: {
                            type: "two_way",
                            language_a: langA,
                            language_b: langB
                        }
                    };
                } else {
                    // Normal mode: I speak MY language, translate to THEIR language
                    config = {
                        api_key: STATE.sonioxApiKey,
                        model: "stt-rt-v4",
                        audio_format: "pcm_s16le",
                        sample_rate: 16000,
                        num_channels: 1,
                        language: myLang,
                        enable_endpoint_detection: true,
                        max_endpoint_delay_ms: 2500,
                        translation: {
                            type: "one_way",
                            target_language: theirLang
                        }
                    };
                }

                var ctx = buildSonioxContext();
                if (ctx) config.context = ctx;

                ws.send(JSON.stringify(config));
                STATE.sonioxReady = true;
                STATE.sonioxSessionStart = Date.now();
                STATE.idleTimer = Date.now();
                updateSonioxStatus("connected");

                STATE.keepaliveInterval = setInterval(function () {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: "keepalive" }));
                    }
                }, 25000);

                STATE.idleCheckInterval = setInterval(function () {
                    if (Date.now() - STATE.idleTimer > 1800000) {
                        showToast("30 min idle. Connection closed.", "error");
                        disconnectSoniox();
                    }
                }, 60000);

                // Auto-refresh session every 3 minutes to prevent drift
                clearInterval(STATE.sessionRefreshInterval);
                STATE.sessionRefreshInterval = setInterval(function () {
                    if (!STATE.isRecording && STATE.sonioxWs && STATE.sonioxWs.readyState === WebSocket.OPEN) {
                        console.log('[Soniox] Auto-refreshing session...');
                        refreshSonioxSession();
                    }
                }, 180000);
            };

            ws.onmessage = function (event) {
                try {
                    var res = JSON.parse(event.data);
                    if (res.error_code) {
                        showToast("Soniox: " + (res.error_message || res.error_code), "error");
                        disconnectSoniox();
                        return;
                    }
                    processTokens(res);
                    if (res.finished) {
                        // Stream ended — wait briefly for any trailing translation tokens
                        clearTimeout(STATE.flushTimer);
                        STATE.flushTimer = setTimeout(function () {
                            flushToFirebase();
                        }, 500);
                    }
                } catch (e) {}
            };

            ws.onerror = function () {
                updateSonioxStatus("error");
            };

            ws.onclose = function () {
                STATE.sonioxReady = false;
                STATE.sonioxWs = null;
                clearInterval(STATE.keepaliveInterval);
                clearInterval(STATE.idleCheckInterval);
                updateSonioxStatus("disconnected");
            };
        } catch (e) {
            showToast("WebSocket connection failed", "error");
        }
    }

    function refreshSonioxSession() {
        if (STATE.sonioxWs) {
            try { STATE.sonioxWs.close(); } catch (e) {}
            STATE.sonioxWs = null;
        }
        STATE.sonioxReady = false;
        clearInterval(STATE.keepaliveInterval);
        clearInterval(STATE.idleCheckInterval);
        connectSoniox();
    }

    function disconnectSoniox() {
        if (STATE.sonioxWs) {
            try {
                if (STATE.sonioxWs.readyState === WebSocket.OPEN) {
                    STATE.sonioxWs.send("");
                }
                STATE.sonioxWs.close();
            } catch (e) {}
            STATE.sonioxWs = null;
        }
        STATE.sonioxReady = false;
        clearInterval(STATE.keepaliveInterval);
        clearInterval(STATE.idleCheckInterval);
        clearInterval(STATE.sessionRefreshInterval);
        clearTimeout(STATE.flushTimer);
        if (STATE.originalBuffer.length > 0) {
            flushToFirebase();
        }
        updateSonioxStatus("disconnected");
    }

    function processTokens(res) {
        var tokens = res.tokens || [];
        var hasNewFinal = false;
        var nonFinalOriginal = [];
        var nonFinalTranslated = [];

        for (var i = 0; i < tokens.length; i++) {
            var token = tokens[i];
            if (!token.text) continue;

            if (token.is_final) {
                hasNewFinal = true;
                STATE.idleTimer = Date.now();
                if (token.translation_status === "translation") {
                    STATE.translatedBuffer.push(token);
                } else {
                    STATE.originalBuffer.push(token);
                    // Track the detected language from Soniox for correct lang tagging
                    if (token.language) {
                        STATE.detectedOriginalLang = token.language;
                    }
                }
            } else {
                if (token.translation_status === "translation") {
                    nonFinalTranslated.push(token);
                } else {
                    nonFinalOriginal.push(token);
                    if (token.language) {
                        STATE.detectedOriginalLang = token.language;
                    }
                }
            }
        }

        var previewParts = [];
        STATE.originalBuffer.forEach(function (t) { previewParts.push(t.text); });
        nonFinalOriginal.forEach(function (t) { previewParts.push(t.text); });
        var previewText = cleanSonioxText(previewParts.join(""));
        var previewEl = $("#transcription-preview");
        var previewTextEl = $("#preview-text");
        if (previewText && STATE.isRecording) {
            previewTextEl.textContent = previewText;
            previewEl.style.display = "block";
        } else if (!STATE.isRecording) {
            previewEl.style.display = "none";
        }

        if (hasNewFinal && shouldFlush()) {
            // Sentence boundary detected — but wait for translation tokens to arrive
            clearTimeout(STATE.flushTimer);
            if (STATE.translatedBuffer.length > 0) {
                // Translation already arrived, flush after short delay for any trailing tokens
                STATE.flushTimer = setTimeout(function () {
                    flushToFirebase();
                }, 400);
            } else {
                // No translation yet — wait longer for it to arrive
                STATE.flushTimer = setTimeout(function () {
                    flushToFirebase();
                }, 1500);
            }
        } else if (hasNewFinal) {
            clearTimeout(STATE.flushTimer);
            STATE.flushTimer = setTimeout(function () {
                if (STATE.originalBuffer.length > 0) {
                    flushToFirebase();
                }
            }, 3500);
        }
    }

    function shouldFlush() {
        if (STATE.originalBuffer.length === 0) return false;
        var text = STATE.originalBuffer.map(function (t) { return t.text; }).join("").trim();
        if (!text) return false;
        var lastChar = text[text.length - 1];
        // Flush on sentence-ending punctuation
        if (".?!。？！…\n".indexOf(lastChar) !== -1) return true;
        // Flush on long text (increased threshold for better grouping)
        if (text.length > 100) return true;
        if (STATE.translatedBuffer.length > 0) {
            var tText = STATE.translatedBuffer.map(function (t) { return t.text; }).join("").trim();
            if (tText && ".?!。？！…\n".indexOf(tText[tText.length - 1]) !== -1) return true;
        }
        return false;
    }

    function cleanSonioxText(text) {
        return text.replace(/<end>/gi, '').replace(/\s+/g, ' ').trim();
    }

    function flushToFirebase() {
        clearTimeout(STATE.flushTimer);
        if (STATE.originalBuffer.length === 0) return;

        var origText = cleanSonioxText(STATE.originalBuffer.map(function (t) { return t.text; }).join(""));
        var transText = cleanSonioxText(STATE.translatedBuffer.map(function (t) { return t.text; }).join(""));

        if (!origText) {
            STATE.originalBuffer = [];
            STATE.translatedBuffer = [];
            return;
        }

        // Determine languages:
        // In normal mode: original is my language, translated is the other
        // In solo mode: use detected language from Soniox, translation target is the other side
        var origLang, transLang;
        if (STATE.soloMode && STATE.detectedOriginalLang) {
            origLang = STATE.detectedOriginalLang;
            // The translation is to the "other" language in the two_way pair
            var myLang = STATE.targetLang || "vi";
            var otherLang = myLang === "vi" ? "ja" : myLang === "ja" ? "vi" : "en";
            transLang = (origLang === myLang) ? otherLang : myLang;
        } else {
            origLang = STATE.targetLang;
            transLang = STATE.targetLang === "vi" ? "ja" : STATE.targetLang === "ja" ? "vi" : "en";
        }

        var msg = {
            sender: STATE.userName,
            originalLang: origLang,
            originalText: origText,
            translatedText: transText,
            translatedLang: transLang,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        };

        STATE.originalBuffer = [];
        STATE.translatedBuffer = [];
        STATE.detectedOriginalLang = null;

        $("#transcription-preview").style.display = "none";

        if (STATE.currentRoomId) {
            STATE.db.ref("rooms/" + STATE.currentRoomId + "/messages").push(msg);
        }
    }

    function renderMessage(msg) {
        var container = $("#chat-messages");
        var chatContainer = $("#chat-container");
        var isSelf = msg.sender === STATE.userName;

        // Clean any residual <end> tags from database
        msg.originalText = cleanSonioxText(msg.originalText || "");
        msg.translatedText = cleanSonioxText(msg.translatedText || "");

        // Don't render if both texts are empty
        if (!msg.originalText && !msg.translatedText) return;

        var display = getDisplayTexts(msg, STATE.targetLang);

        var group = document.createElement("div");
        group.className = "message-group" + (isSelf ? " self-message" : "");

        var header = document.createElement("div");
        header.className = "message-header";

        var avatar = document.createElement("span");
        avatar.className = "sender-avatar";
        avatar.textContent = (msg.sender || "?").charAt(0).toUpperCase();
        avatar.style.backgroundColor = isSelf ? 'var(--success)' : nameToColor(msg.sender || "");
        header.appendChild(avatar);

        var nameSpan = document.createElement("span");
        nameSpan.className = "sender-name";
        nameSpan.textContent = msg.sender;
        nameSpan.style.color = isSelf ? 'var(--success)' : nameToColor(msg.sender || "");
        header.appendChild(nameSpan);

        var timeSpan = document.createElement("span");
        timeSpan.className = "message-time";
        timeSpan.textContent = formatTime(msg.timestamp || Date.now());
        header.appendChild(timeSpan);

        if (msg.isTextOnly) {
            var badge = document.createElement("span");
            badge.className = "text-only-badge";
            badge.textContent = "TEXT";
            header.appendChild(badge);
        }

        group.appendChild(header);

        var mainDiv = document.createElement("div");
        mainDiv.className = "translated-text";
        mainDiv.textContent = display.mainText;
        group.appendChild(mainDiv);

        var hasTranslation = msg.translatedText && msg.translatedText.trim();
        if (hasTranslation && display.subtitleText && display.subtitleText !== display.mainText) {
            var subDiv = document.createElement("div");
            subDiv.className = "original-text";
            var langTag = document.createElement("span");
            langTag.className = "lang-tag";
            langTag.textContent = getLangLabel(display.subtitleLang);
            subDiv.appendChild(langTag);
            subDiv.appendChild(document.createTextNode(" " + display.subtitleText));
            group.appendChild(subDiv);
        }

        container.appendChild(group);
        requestAnimationFrame(function () {
            chatContainer.scrollTop = chatContainer.scrollHeight;
        });

        // Store message for export report
        STATE.messageHistory.push(msg);

        // TTS: read translated messages and also solo mode self-messages
        var isNewMessage = msg.timestamp && msg.timestamp > STATE.joinedAtTime;
        if (isNewMessage && !msg.isTextOnly) {
            var shouldTTS = false;
            var ttsText = '';
            var ttsLang = STATE.targetLang;

            if (isSelf && STATE.soloMode) {
                // In solo mode, read back the translated text (in my target language)
                if (msg.translatedLang === STATE.targetLang && msg.translatedText) {
                    ttsText = msg.translatedText;
                    shouldTTS = true;
                } else if (msg.originalLang !== STATE.targetLang && msg.translatedText) {
                    // Speaker spoke foreign language, translation should be in my language
                    ttsText = msg.translatedText;
                    ttsLang = msg.translatedLang;
                    shouldTTS = true;
                }
            } else if (!isSelf) {
                // Normal mode: read other people's messages in MY language
                var isSameLang = msg.originalLang === STATE.targetLang;
                if (!isSameLang) {
                    if (msg.translatedLang === STATE.targetLang && msg.translatedText) {
                        ttsText = msg.translatedText;
                    } else if (msg.originalLang === STATE.targetLang && msg.originalText) {
                        ttsText = msg.originalText;
                    }
                    shouldTTS = !!ttsText;
                }
            }

            if (shouldTTS && ttsText) {
                queueTTS(ttsText, ttsLang);
            }
        }
    }

    function getDisplayTexts(msg, myTargetLang) {
        if (msg.isTextOnly) {
            return {
                mainText: msg.originalText,
                subtitleText: "",
                subtitleLang: "",
                ttsText: "",
                ttsLang: ""
            };
        }
        if (msg.translatedLang === myTargetLang) {
            var hasTranslated = msg.translatedText && msg.translatedText.trim();
            return {
                mainText: hasTranslated ? msg.translatedText : msg.originalText,
                subtitleText: hasTranslated ? msg.originalText : '',
                subtitleLang: hasTranslated ? msg.originalLang : '',
                ttsText: hasTranslated ? msg.translatedText : '',
                ttsLang: hasTranslated ? msg.translatedLang : ''
            };
        }
        if (msg.originalLang === myTargetLang) {
            return {
                mainText: msg.originalText,
                subtitleText: msg.translatedText,
                subtitleLang: msg.translatedLang,
                ttsText: msg.originalText,
                ttsLang: msg.originalLang
            };
        }
        return {
            mainText: msg.translatedText || msg.originalText,
            subtitleText: msg.originalText,
            subtitleLang: msg.originalLang,
            ttsText: msg.translatedText || msg.originalText,
            ttsLang: msg.translatedLang || msg.originalLang
        };
    }

    function queueTTS(text, lang) {
        var item = { text: text, lang: lang };
        item.audioPromise = fetchEdgeTTSAudio(text, lang).catch(function () { return null; });
        STATE.ttsQueue.push(item);
        if (!STATE.ttsPlaying) processTTSQueue();
    }

    function processTTSQueue() {
        if (STATE.ttsQueue.length === 0) {
            STATE.ttsPlaying = false;
            return;
        }

        STATE.ttsPlaying = true;
        var item = STATE.ttsQueue.shift();

        item.audioPromise
            .then(function (blob) {
                if (blob) return playAudioBlob(blob);
                return fallbackWebSpeech(item.text, item.lang);
            })
            .then(function () { processTTSQueue(); })
            .catch(function () {
                fallbackWebSpeech(item.text, item.lang)
                    .then(function () { processTTSQueue(); });
            });
    }

    function downsample(buffer, inputRate, outputRate) {
        if (inputRate === outputRate) return buffer;
        var ratio = inputRate / outputRate;
        var newLen = Math.round(buffer.length / ratio);
        var result = new Float32Array(newLen);
        for (var i = 0; i < newLen; i++) {
            var idx = Math.round(i * ratio);
            result[i] = buffer[Math.min(idx, buffer.length - 1)];
        }
        return result;
    }

    function float32ToInt16(float32) {
        var int16 = new Int16Array(float32.length);
        for (var i = 0; i < float32.length; i++) {
            var s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return int16;
    }

    async function startRecording() {
        if (STATE.isRecording) return;
        unlockAudioContext();

        if (!STATE.sonioxWs || STATE.sonioxWs.readyState !== WebSocket.OPEN) {
            connectSoniox();
            await new Promise(function (resolve) {
                var attempts = 0;
                var check = setInterval(function () {
                    attempts++;
                    if (STATE.sonioxReady || attempts > 30) {
                        clearInterval(check);
                        resolve();
                    }
                }, 100);
            });
            if (!STATE.sonioxReady) {
                showToast("Could not connect to Soniox", "error");
                return;
            }
        }

        try {
            STATE.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
        } catch (e) {
            showToast("Microphone access denied", "error");
            return;
        }

        if (!STATE.audioContext || STATE.audioContext.state === "closed") {
            STATE.audioContext = new AudioContext();
        }
        if (STATE.audioContext.state === "suspended") {
            await STATE.audioContext.resume();
        }

        var inputRate = STATE.audioContext.sampleRate;
        STATE.sourceNode = STATE.audioContext.createMediaStreamSource(STATE.mediaStream);
        STATE.scriptProcessor = STATE.audioContext.createScriptProcessor(4096, 1, 1);

        STATE.sourceNode.connect(STATE.scriptProcessor);
        STATE.scriptProcessor.connect(STATE.audioContext.destination);

        STATE.scriptProcessor.onaudioprocess = function (e) {
            if (!STATE.isRecording) return;
            if (!STATE.sonioxWs || STATE.sonioxWs.readyState !== WebSocket.OPEN) return;
            var input = e.inputBuffer.getChannelData(0);
            var resampled = downsample(input, inputRate, 16000);
            var int16 = float32ToInt16(resampled);
            STATE.sonioxWs.send(int16.buffer);
        };

        STATE.isRecording = true;
        STATE.idleTimer = Date.now();
        STATE.originalBuffer = [];
        STATE.translatedBuffer = [];

        var micBtn = $("#mic-btn");
        micBtn.classList.add("recording");
        micBtn.querySelector(".mic-icon").style.display = "none";
        micBtn.querySelector(".mic-off-icon").style.display = "block";
        $("#mic-status-text").textContent = STATE.soloMode ? "Listening..." : "Recording...";
    }

    function stopRecording() {
        if (!STATE.isRecording) return;
        STATE.isRecording = false;

        if (STATE.scriptProcessor) {
            STATE.scriptProcessor.disconnect();
            STATE.scriptProcessor = null;
        }
        if (STATE.sourceNode) {
            STATE.sourceNode.disconnect();
            STATE.sourceNode = null;
        }
        if (STATE.mediaStream) {
            STATE.mediaStream.getTracks().forEach(function (t) { t.stop(); });
            STATE.mediaStream = null;
        }

        setTimeout(function () {
            if (STATE.originalBuffer.length > 0) {
                flushToFirebase();
            }
            $("#transcription-preview").style.display = "none";
        }, 500);

        var micBtn = $("#mic-btn");
        micBtn.classList.remove("recording");
        micBtn.querySelector(".mic-icon").style.display = "block";
        micBtn.querySelector(".mic-off-icon").style.display = "none";
        if (STATE.soloMode) {
            $("#mic-status-text").textContent = "Tap to start listening";
        } else {
            $("#mic-status-text").textContent =
                STATE.userCount >= 2 ? "Hold to talk" : "Waiting for participants...";
        }
    }

    function updateSonioxStatus(status) {
        var dot = $("#soniox-status .status-dot");
        var text = $("#soniox-status .status-text");
        dot.className = "status-dot";
        if (status === "connected") {
            dot.classList.add("connected");
            text.textContent = "Connected";
        } else if (status === "error") {
            dot.classList.add("error");
            text.textContent = "Error";
        } else {
            text.textContent = "Ready";
        }
    }

    function setupSetupView() {
        var nameInput = $("#user-name-input");
        var langSelect = $("#target-lang-select");
        var speedSelect = $("#tts-speed-select");
        var keyInput = $("#soniox-key-input");
        var continueBtn = $("#setup-continue-btn");
        var toggleBtn = $("#toggle-key-btn");

        nameInput.value = STATE.userName;
        langSelect.value = STATE.targetLang;
        speedSelect.value = STATE.ttsSpeed;
        keyInput.value = STATE.sonioxApiKey;

        function checkReady() {
            continueBtn.disabled = !(
                nameInput.value.trim().length > 0 && keyInput.value.trim().length > 0
            );
        }

        nameInput.addEventListener("input", checkReady);
        keyInput.addEventListener("input", checkReady);
        checkReady();

        toggleBtn.addEventListener("click", function () {
            var isPassword = keyInput.type === "password";
            keyInput.type = isPassword ? "text" : "password";
            $("#eye-open").style.display = isPassword ? "none" : "block";
            $("#eye-closed").style.display = isPassword ? "block" : "none";
        });

        continueBtn.addEventListener("click", function () {
            STATE.userName = nameInput.value.trim();
            STATE.targetLang = langSelect.value;
            STATE.ttsSpeed = speedSelect.value;
            STATE.sonioxApiKey = keyInput.value.trim();

            if (!STATE.userName || !STATE.sonioxApiKey) return;

            saveSettings();

            if (!initFirebase()) return;

            $("#lobby-user-badge").textContent =
                STATE.userName + " · " + getLangLabel(STATE.targetLang);

            loadRooms();
            showView("lobby-view");
        });
    }

    function setupLobbyView() {
        $("#create-room-btn").addEventListener("click", function () {
            $("#create-room-modal").style.display = "flex";
            $("#room-name-input").value = "";
            $("#room-private-check").checked = false;
            $("#room-password-group").style.display = "none";
            $("#room-password-input").value = "";
            $("#confirm-create-btn").disabled = true;
            setTimeout(function () { $("#room-name-input").focus(); }, 100);
        });

        $("#close-modal-btn").addEventListener("click", function () {
            $("#create-room-modal").style.display = "none";
        });

        $("#cancel-create-btn").addEventListener("click", function () {
            $("#create-room-modal").style.display = "none";
        });

        $("#room-name-input").addEventListener("input", function () {
            $("#confirm-create-btn").disabled = $("#room-name-input").value.trim().length < 1;
        });

        $("#room-private-check").addEventListener("change", function (e) {
            $("#room-password-group").style.display = e.target.checked ? "flex" : "none";
        });

        $("#confirm-create-btn").addEventListener("click", async function () {
            var name = $("#room-name-input").value.trim();
            var isPrivate = $("#room-private-check").checked;
            var password = $("#room-password-input").value;

            if (!name) return;
            if (isPrivate && !password) {
                showToast("Please enter a password", "error");
                return;
            }

            try {
                var roomId = await createRoom(name, isPrivate, password);
                $("#create-room-modal").style.display = "none";
                showToast("Room created!", "success");
                await joinRoom(roomId, name);
            } catch (e) {
                showToast("Failed to create room", "error");
            }
        });

        $("#refresh-rooms-btn").addEventListener("click", function () { loadRooms(); });

        $("#settings-btn").addEventListener("click", function () {
            showView("setup-view");
        });

        $("#close-join-modal-btn").addEventListener("click", function () {
            $("#join-password-modal").style.display = "none";
        });

        $("#cancel-join-btn").addEventListener("click", function () {
            $("#join-password-modal").style.display = "none";
        });

        $("#confirm-join-btn").addEventListener("click", async function () {
            var room = STATE.pendingJoinRoom;
            if (!room) return;
            var password = $("#join-password-input").value;

            try {
                var snap = await STATE.db.ref("rooms/" + room.id + "/passwordHash").once("value");
                var storedHash = snap.val();
                var inputHash = await hashPassword(password);

                if (inputHash === storedHash) {
                    $("#join-password-modal").style.display = "none";
                    if (STATE.passwordAction === 'delete') {
                        await deleteRoom(room.id);
                    } else {
                        await joinRoom(room.id, room.name);
                    }
                } else {
                    $("#join-password-error").style.display = "block";
                }
            } catch (e) {
                showToast("Verification failed", "error");
            }
        });

        $("#join-password-input").addEventListener("keydown", function (e) {
            if (e.key === "Enter") $("#confirm-join-btn").click();
        });
    }

    function setupRoomView() {
        var micBtn = $("#mic-btn");

        micBtn.addEventListener("mousedown", function (e) {
            if (micBtn.disabled) return;
            e.preventDefault();
            if (STATE.soloMode) {
                // Toggle mode for solo
                if (STATE.isRecording) { stopRecording(); } else { startRecording(); }
            } else {
                startRecording();
            }
        });

        micBtn.addEventListener("mouseup", function () {
            if (!STATE.soloMode) stopRecording();
        });
        micBtn.addEventListener("mouseleave", function () {
            if (!STATE.soloMode && STATE.isRecording) stopRecording();
        });

        micBtn.addEventListener("touchstart", function (e) {
            if (micBtn.disabled) return;
            e.preventDefault();
            if (STATE.soloMode) {
                if (STATE.isRecording) { stopRecording(); } else { startRecording(); }
            } else {
                startRecording();
            }
        }, { passive: false });

        micBtn.addEventListener("touchend", function (e) {
            e.preventDefault();
            if (!STATE.soloMode) stopRecording();
        }, { passive: false });

        micBtn.addEventListener("touchcancel", function () {
            if (!STATE.soloMode && STATE.isRecording) stopRecording();
        });

        $("#leave-room-btn").addEventListener("click", async function () {
            if (STATE.isRecording) stopRecording();
            disconnectSoniox();
            cleanupRoomListeners();

            if (STATE.audioContext && STATE.audioContext.state !== "closed") {
                STATE.audioContext.close();
                STATE.audioContext = null;
            }

            var myRef = STATE.db.ref(
                "rooms/" + STATE.currentRoomId + "/users/" + STATE.userId
            );
            myRef.remove();

            STATE.currentRoomId = null;
            STATE.renderedMessageKeys.clear();
            STATE.messageHistory = [];
            STATE.ttsQueue = [];
            if (window.speechSynthesis) speechSynthesis.cancel();

            await loadRooms();
            showView("lobby-view");
            showToast("Left room", "info");
        });

        $("#export-report-btn").addEventListener("click", function () {
            exportReport();
        });

        var textInput = $("#text-message-input");

        function sendTextMessage() {
            var text = textInput.value.trim();
            if (!text || !STATE.currentRoomId) return;
            textInput.value = "";

            var msg = {
                sender: STATE.userName,
                originalLang: STATE.targetLang,
                originalText: text,
                translatedText: "",
                translatedLang: "",
                isTextOnly: true,
                timestamp: firebase.database.ServerValue.TIMESTAMP
            };
            STATE.db.ref("rooms/" + STATE.currentRoomId + "/messages").push(msg);
        }

        $("#send-text-btn").addEventListener("click", sendTextMessage);
        textInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendTextMessage();
            }
        });
    }

    function init() {
        loadSettings();
        setupSetupView();
        setupLobbyView();
        setupRoomView();

        // Pre-create the TTS audio element early so it's ready for priming
        initTTS();

        // Install global gesture listeners to unlock audio on ANY user interaction.
        // iOS Safari only allows audio playback from direct user gesture handlers.
        // We attach to the CAPTURING phase so we catch the gesture before anything else.
        var gestureEvents = ['touchstart', 'touchend', 'mousedown', 'click', 'keydown'];
        function onUserGesture() {
            unlockAudioContext();
            // Once fully unlocked, remove listeners to avoid overhead
            if (STATE.audioUnlocked && STATE.ttsAudioElementReady) {
                gestureEvents.forEach(function (evt) {
                    document.removeEventListener(evt, onUserGesture, true);
                });
                console.log('[TTS] All gesture listeners removed — audio permanently unlocked');
            }
        }
        gestureEvents.forEach(function (evt) {
            document.addEventListener(evt, onUserGesture, true);
        });

        if (STATE.userName && STATE.sonioxApiKey) {
            $("#user-name-input").value = STATE.userName;
            $("#target-lang-select").value = STATE.targetLang;
            $("#soniox-key-input").value = STATE.sonioxApiKey;
        }
    }

    function exportReport() {
        if (STATE.messageHistory.length === 0) {
            showToast("No messages to export", "error");
            return;
        }

        var myLang = STATE.targetLang;
        var langNames = { vi: 'Tiếng Việt', ja: '日本語', en: 'English', ko: '한국어', zh: '中文' };
        var now = new Date();
        var dateStr = now.getFullYear() + '-' +
            String(now.getMonth() + 1).padStart(2, '0') + '-' +
            String(now.getDate()).padStart(2, '0') + ' ' +
            String(now.getHours()).padStart(2, '0') + ':' +
            String(now.getMinutes()).padStart(2, '0');

        var lines = [];
        lines.push('═══════════════════════════════════════');
        lines.push('  MEETING REPORT');
        lines.push('═══════════════════════════════════════');
        lines.push('Room: ' + STATE.currentRoomName);
        lines.push('Language: ' + (langNames[myLang] || myLang));
        lines.push('Exported: ' + dateStr);
        lines.push('Total Messages: ' + STATE.messageHistory.length);
        lines.push('═══════════════════════════════════════');
        lines.push('');

        var seen = {};
        var exportCount = 0;

        STATE.messageHistory.forEach(function (msg) {
            var text = '';
            if (msg.isTextOnly) {
                text = msg.originalText || '';
            } else if (msg.translatedLang === myLang && msg.translatedText) {
                text = msg.translatedText;
            } else if (msg.originalLang === myLang && msg.originalText) {
                text = msg.originalText;
            } else {
                text = msg.translatedText || msg.originalText || '';
            }

            text = text.trim();
            if (!text) return;

            // Deduplicate: skip if same sender said the exact same text
            var dedupKey = (msg.sender || '') + '||' + text;
            if (seen[dedupKey]) return;
            seen[dedupKey] = true;

            var time = formatTime(msg.timestamp || Date.now());
            var sender = msg.sender || 'Unknown';
            var tag = msg.isTextOnly ? ' [TEXT]' : '';

            lines.push('[' + time + '] ' + sender + tag + ':');
            lines.push('  ' + text);
            lines.push('');
            exportCount++;
        });

        lines.push('───────────────────────────────────────');
        lines.push('Exported ' + exportCount + ' unique messages.');
        lines.push('───────────────────────────────────────');

        var content = lines.join('\n');
        var blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        var url = URL.createObjectURL(blob);

        var a = document.createElement('a');
        a.href = url;
        a.download = 'meeting_' + (STATE.currentRoomName || 'report').replace(/[^a-zA-Z0-9_\-]/g, '_') + '_' + dateStr.replace(/[: ]/g, '') + '.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('Report exported (' + exportCount + ' messages)', 'success');
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
