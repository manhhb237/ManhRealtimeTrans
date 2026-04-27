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
        ttsEnabled: false,
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
        if (STATE.audioUnlocked) return;

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

        // 2) Unlock Web Speech API (TTS) for mobile fallback
        try {
            if (window.speechSynthesis) {
                var u = new SpeechSynthesisUtterance('');
                u.volume = 0;
                speechSynthesis.speak(u);
            }
        } catch (e) {}

        // 3) Prime the persistent HTML5 Audio element
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
                        setTimeout(function () { URL.revokeObjectURL(silentUrl); }, 500);
                    }).catch(function (e) {
                        console.warn('[TTS] Persistent audio unlock failed:', e);
                        setTimeout(function () { URL.revokeObjectURL(silentUrl); }, 500);
                    });
                } else {
                    STATE.ttsAudioElementReady = true;
                    STATE.audioUnlocked = true;
                    setTimeout(function () { URL.revokeObjectURL(silentUrl); }, 500);
                }
            } catch (e) {
                console.warn('[TTS] Persistent audio creation failed:', e);
            }
        } else {
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

    function playTTSUrl(url) {
        return new Promise(function (resolve, reject) {
            if (!url) { resolve(); return; }

            var rate = 1.0;
            if (STATE.ttsSpeed === "-20%") rate = 0.8;
            if (STATE.ttsSpeed === "+20%") rate = 1.2;
            if (STATE.ttsSpeed === "+40%") rate = 1.4;

            // Safety timeout: if audio doesn't end in 15s, force resolve
            var settled = false;
            var safetyTimer = setTimeout(function () {
                if (!settled) {
                    settled = true;
                    console.warn('[TTS] Safety timeout — forcing next in queue');
                    resolve();
                }
            }, 15000);

            function done() {
                if (settled) return;
                settled = true;
                clearTimeout(safetyTimer);
                resolve();
            }
            function fail(e) {
                if (settled) return;
                settled = true;
                clearTimeout(safetyTimer);
                reject(e);
            }

            if (STATE.ttsAudioElement && STATE.ttsAudioElementReady) {
                var el = STATE.ttsAudioElement;
                var onEnded = function () {
                    el.removeEventListener('ended', onEnded);
                    el.removeEventListener('error', onError);
                    done();
                };
                var onError = function (e) {
                    el.removeEventListener('ended', onEnded);
                    el.removeEventListener('error', onError);
                    fail(e);
                };

                el.addEventListener('ended', onEnded);
                el.addEventListener('error', onError);
                el.src = url;
                el.playbackRate = rate;
                el.defaultPlaybackRate = rate;
                
                var playPromise = el.play();
                if (playPromise && playPromise.catch) {
                    playPromise.catch(function (e) {
                        el.removeEventListener('ended', onEnded);
                        el.removeEventListener('error', onError);
                        fail(e);
                    });
                }
            } else {
                var audio = new Audio(url);
                audio.playbackRate = rate;
                audio.defaultPlaybackRate = rate;
                audio.onended = function () { done(); };
                audio.onerror = function () { fail(); };
                audio.play().catch(function (e) { fail(e); });
            }
        });
    }

    function fallbackWebSpeech(text, lang) {
        return new Promise(function (resolve, reject) {
            if (!window.speechSynthesis) { reject('no speechSynthesis'); return; }
            var u = new SpeechSynthesisUtterance(text);
            u.lang = lang === 'vi' ? 'vi-VN' : 'ja-JP';
            var rate = 1.0;
            if (STATE.ttsSpeed === "-20%") rate = 0.8;
            if (STATE.ttsSpeed === "+20%") rate = 1.2;
            if (STATE.ttsSpeed === "+40%") rate = 1.4;
            u.rate = rate;
            u.onend = function () { resolve(); };
            u.onerror = function (e) { reject(e); };
            // Safety: if speech doesn't finish in 20s, resolve anyway
            var fallbackTimer = setTimeout(function () { resolve(); }, 20000);
            var origOnEnd = u.onend;
            u.onend = function () { clearTimeout(fallbackTimer); resolve(); };
            u.onerror = function (e) { clearTimeout(fallbackTimer); reject(e); };
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
            var sysBtn = $("#system-audio-btn");
            var micStatus = $("#mic-status-text");
            var waitOverlay = $("#waiting-overlay");

            if (count === 1) {
                // Solo listening mode
                STATE.soloMode = true;
                micBtn.disabled = false;
                if (sysBtn) sysBtn.disabled = false;
                waitOverlay.style.display = "none";
                if (!STATE.isRecording) {
                    micStatus.textContent = "Tap to start listening";
                }
            } else if (count >= 2) {
                STATE.soloMode = false;
                micBtn.disabled = false;
                if (sysBtn) sysBtn.disabled = false;
                micStatus.textContent = STATE.isRecording ? "Listening..." : "Tap to start listening";
                waitOverlay.style.display = "none";
            } else {
                STATE.soloMode = false;
                micBtn.disabled = true;
                if (sysBtn) sysBtn.disabled = true;
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

                // Always use two_way translation with language ID so that if someone speaks a different language,
                // it is correctly tagged and transcribed.
                var config = {
                    api_key: STATE.sonioxApiKey,
                    model: "stt-rt-v4",
                    audio_format: "pcm_s16le",
                    sample_rate: 16000,
                    num_channels: 1,
                    language_hints: [myLang, theirLang],
                    enable_language_identification: true,
                    enable_endpoint_detection: true,
                    max_endpoint_delay_ms: 2500,
                    translation: {
                        type: "two_way",
                        language_a: myLang,
                        language_b: theirLang
                    }
                };

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

        // Use detected language from Soniox for accurate tagging
        var origLang, transLang;
        if (STATE.detectedOriginalLang) {
            origLang = STATE.detectedOriginalLang;
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

        // TTS: read translated messages and also solo mode self-messages (bilingual)
        var isNewMessage = msg.timestamp && msg.timestamp > STATE.joinedAtTime;
        if (isNewMessage && !msg.isTextOnly && STATE.ttsEnabled) {
            if (isSelf && STATE.soloMode) {
                // Solo mode: read only the translation in the opposite language
                // vi input → read ja translation, ja input → read vi translation
                var origLang = msg.originalLang || STATE.targetLang;
                var transText = msg.translatedText || '';
                var transLang = msg.translatedLang || (origLang === 'vi' ? 'ja' : 'vi');

                if (transText.trim()) {
                    queueTTS(transText, transLang);
                }
            } else if (!isSelf) {
                // Multi-user mode: read the message in MY language
                var ttsText = '';
                var ttsLang = STATE.targetLang;

                if (msg.translatedLang === STATE.targetLang && msg.translatedText) {
                    ttsText = msg.translatedText;
                } else if (msg.originalLang === STATE.targetLang && msg.originalText) {
                    ttsText = msg.originalText;
                } else if (msg.translatedText) {
                    // Fallback: read whatever translation is available
                    ttsText = msg.translatedText;
                    ttsLang = msg.translatedLang || STATE.targetLang;
                } else if (msg.originalText) {
                    ttsText = msg.originalText;
                    ttsLang = msg.originalLang || STATE.targetLang;
                }

                if (ttsText.trim()) {
                    queueTTS(ttsText, ttsLang);
                }
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

    // Split text into chunks suitable for Google TTS (max ~180 chars per chunk)
    function splitTTSText(text) {
        var MAX = 180;
        if (text.length <= MAX) return [text];
        var chunks = [];
        // Try to split on sentence boundaries first
        var sentences = text.match(/[^.!?。！？]+[.!?。！？]*/g) || [text];
        var current = '';
        for (var i = 0; i < sentences.length; i++) {
            var s = sentences[i].trim();
            if (!s) continue;
            if (current.length + s.length + 1 <= MAX) {
                current = current ? current + ' ' + s : s;
            } else {
                if (current) chunks.push(current);
                // If single sentence is still too long, force-split by words
                if (s.length > MAX) {
                    var words = s.split(/\s+/);
                    current = '';
                    for (var j = 0; j < words.length; j++) {
                        if (current.length + words[j].length + 1 <= MAX) {
                            current = current ? current + ' ' + words[j] : words[j];
                        } else {
                            if (current) chunks.push(current);
                            current = words[j];
                        }
                    }
                } else {
                    current = s;
                }
            }
        }
        if (current) chunks.push(current);
        return chunks.length > 0 ? chunks : [text.substring(0, MAX)];
    }

    function queueTTS(text, lang) {
        var chunks = splitTTSText(text);
        for (var i = 0; i < chunks.length; i++) {
            var chunk = chunks[i];
            var safeText = encodeURIComponent(chunk);
            var item = {
                text: chunk,
                lang: lang,
                audioUrl: 'https://translate.googleapis.com/translate_tts?client=gtx&ie=UTF-8&tl=' + lang + '&q=' + safeText
            };
            STATE.ttsQueue.push(item);
        }
        console.log('[TTS] Queued ' + chunks.length + ' chunk(s) for lang=' + lang + ': ' + text.substring(0, 60));
        if (!STATE.ttsPlaying) processTTSQueue();
    }

    function processTTSQueue() {
        if (STATE.ttsQueue.length === 0) {
            STATE.ttsPlaying = false;
            return;
        }

        STATE.ttsPlaying = true;
        var item = STATE.ttsQueue.shift();

        playTTSUrl(item.audioUrl)
            .then(function () { processTTSQueue(); })
            .catch(function (e) {
                console.warn('[TTS] Google TTS failed, trying Web Speech fallback:', e);
                fallbackWebSpeech(item.text, item.lang)
                    .then(function () { processTTSQueue(); })
                    .catch(function () {
                        // Both failed — don't stall, move on
                        console.warn('[TTS] Both TTS methods failed, skipping chunk');
                        processTTSQueue();
                    });
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

    async function startRecording(useSystemAudio) {
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
            if (useSystemAudio) {
                STATE.mediaStream = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: {
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false
                    }
                });
                if (STATE.mediaStream.getAudioTracks().length === 0) {
                    showToast("No system audio shared", "error");
                    STATE.mediaStream.getTracks().forEach(function (t) { t.stop(); });
                    STATE.mediaStream = null;
                    return;
                }
            } else {
                STATE.mediaStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        channelCount: 1,
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                });
            }
        } catch (e) {
            showToast(useSystemAudio ? "System audio access denied" : "Microphone access denied", "error");
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
        var sysBtn = $("#system-audio-btn");
        
        if (useSystemAudio) {
            sysBtn.classList.add("recording");
        } else {
            micBtn.classList.add("recording");
            micBtn.querySelector(".mic-icon").style.display = "none";
            micBtn.querySelector(".mic-off-icon").style.display = "block";
        }
        $("#mic-status-text").textContent = "Listening...";

        // If system audio stream ends (user clicks stop sharing)
        if (useSystemAudio) {
            var audioTrack = STATE.mediaStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.onended = function() {
                    stopRecording();
                };
            }
            var videoTrack = STATE.mediaStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.onended = function() {
                    stopRecording();
                };
            }
        }
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
        var sysBtn = $("#system-audio-btn");
        micBtn.classList.remove("recording");
        sysBtn.classList.remove("recording");
        micBtn.querySelector(".mic-icon").style.display = "block";
        micBtn.querySelector(".mic-off-icon").style.display = "none";
        
        if (STATE.userCount < 2 && !STATE.soloMode) {
            $("#mic-status-text").textContent = "Waiting for participants...";
        } else {
            $("#mic-status-text").textContent = "Tap to start listening";
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
        var sysBtn = $("#system-audio-btn");
        var ttsBtn = $("#tts-toggle-btn");

        ttsBtn.addEventListener("click", function() {
            unlockAudioContext(); // Explicitly unlock audio on toggle
            STATE.ttsEnabled = !STATE.ttsEnabled;
            if (STATE.ttsEnabled) {
                ttsBtn.querySelector(".tts-off-icon").style.display = "none";
                ttsBtn.querySelector(".tts-on-icon").style.display = "block";
                ttsBtn.classList.add("active-state");
                showToast("Auto Text-to-Speech Enabled", "info");
            } else {
                ttsBtn.querySelector(".tts-off-icon").style.display = "block";
                ttsBtn.querySelector(".tts-on-icon").style.display = "none";
                ttsBtn.classList.remove("active-state");
                if (window.speechSynthesis) speechSynthesis.cancel();
                if (STATE.ttsAudioElement) {
                    STATE.ttsAudioElement.pause();
                    STATE.ttsAudioElement.currentTime = 0;
                }
                STATE.ttsQueue = [];
                STATE.ttsPlaying = false;
                showToast("Auto Text-to-Speech Disabled", "info");
            }
        });

        micBtn.addEventListener("mousedown", function (e) {
            if (micBtn.disabled) return;
            e.preventDefault();
            if (STATE.isRecording) { 
                stopRecording(); 
            } else { 
                startRecording(false); 
            }
        });

        // Removed mouseup, mouseleave, touchend, touchcancel logic that forced stopRecording
        // because we are moving entirely to toggle mode.

        micBtn.addEventListener("touchstart", function (e) {
            if (micBtn.disabled) return;
            e.preventDefault();
            if (STATE.isRecording) { 
                stopRecording(); 
            } else { 
                startRecording(false); 
            }
        }, { passive: false });

        // System audio button logic
        sysBtn.addEventListener("click", function (e) {
            if (sysBtn.disabled) return;
            e.preventDefault();
            if (STATE.isRecording) {
                stopRecording();
            } else {
                startRecording(true);
            }
        });

        // Also disable sysBtn when micBtn is disabled (e.g. waiting for participants)
        // This is handled in setupRoomListeners, where micBtn.disabled is toggled. We should observe that or do it there.
        // Actually we will modify the setupRoomListeners directly to toggle sysBtn.disabled.

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
