(function () {
    "use strict";

    var SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
    var LS_PREFIX = "manh_rt_";

    var STATE = {
        userName: "",
        targetLang: "vi",
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
        renderedMessageKeys: new Set(),
        messagesRef: null,
        usersRef: null,
        pendingJoinRoom: null,
        joinedAtTime: 0
    };

    var $ = function (sel) { return document.querySelector(sel); };

    function generateId() {
        return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    }

    function saveSettings() {
        try {
            localStorage.setItem(LS_PREFIX + "username", STATE.userName);
            localStorage.setItem(LS_PREFIX + "targetlang", STATE.targetLang);
            localStorage.setItem(LS_PREFIX + "soniox_key", STATE.sonioxApiKey);
            localStorage.setItem(LS_PREFIX + "userid", STATE.userId);
        } catch (e) {}
    }

    function loadSettings() {
        try {
            STATE.userName = localStorage.getItem(LS_PREFIX + "username") || "";
            STATE.targetLang = localStorage.getItem(LS_PREFIX + "targetlang") || "vi";
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

    function edgeTTS(text, lang) {
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
            }, 15000);

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
                    '<prosody pitch="+0Hz" rate="+0%">' + escapeXml(text) + '</prosody>' +
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
                            var blob = new Blob(audioChunks, { type: 'audio/mp3' });
                            var audioUrl = URL.createObjectURL(blob);
                            var audio = new Audio(audioUrl);
                            audio.onended = function () {
                                URL.revokeObjectURL(audioUrl);
                                resolve();
                            };
                            audio.onerror = function () {
                                URL.revokeObjectURL(audioUrl);
                                reject(new Error('playback'));
                            };
                            audio.play().catch(function () {
                                URL.revokeObjectURL(audioUrl);
                                reject(new Error('play'));
                            });
                        } else {
                            resolve();
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
                    "</span>" + lockIcon + "</div>" +
                    '<div class="room-card-info"><span class="room-card-users"><span class="dot"></span>' +
                    count + " online</span></div>";

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
            $("#join-password-input").value = "";
            $("#join-password-error").style.display = "none";
            $("#join-password-modal").style.display = "flex";
            $("#join-password-input").focus();
        } else {
            joinRoom(room.id, room.name);
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

            if (count < 2) {
                micBtn.disabled = true;
                micStatus.textContent = "Waiting for participants...";
                waitOverlay.style.display = "flex";
                if (STATE.isRecording) stopRecording();
                disconnectSoniox();
            } else {
                micBtn.disabled = false;
                micStatus.textContent = "Hold to talk";
                waitOverlay.style.display = "none";
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
                var config = {
                    api_key: STATE.sonioxApiKey,
                    model: "stt-rt-v4",
                    audio_format: "pcm_s16le",
                    sample_rate: 16000,
                    num_channels: 1,
                    language_hints: ["vi", "ja"],
                    enable_language_identification: true,
                    enable_endpoint_detection: true,
                    translation: {
                        type: "two_way",
                        language_a: "vi",
                        language_b: "ja"
                    }
                };
                ws.send(JSON.stringify(config));
                STATE.sonioxReady = true;
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
                        flushToFirebase();
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
                }
            } else {
                if (token.translation_status === "translation") {
                    nonFinalTranslated.push(token);
                } else {
                    nonFinalOriginal.push(token);
                }
            }
        }

        var previewParts = [];
        STATE.originalBuffer.forEach(function (t) { previewParts.push(t.text); });
        nonFinalOriginal.forEach(function (t) { previewParts.push(t.text); });
        var previewText = previewParts.join("").trim();
        var previewEl = $("#transcription-preview");
        var previewTextEl = $("#preview-text");
        if (previewText && STATE.isRecording) {
            previewTextEl.textContent = previewText;
            previewEl.style.display = "block";
        } else if (!STATE.isRecording) {
            previewEl.style.display = "none";
        }

        if (hasNewFinal && shouldFlush()) {
            flushToFirebase();
        } else if (hasNewFinal) {
            clearTimeout(STATE.flushTimer);
            STATE.flushTimer = setTimeout(function () {
                if (STATE.originalBuffer.length > 0) {
                    flushToFirebase();
                }
            }, 2000);
        }
    }

    function shouldFlush() {
        if (STATE.originalBuffer.length === 0) return false;
        var text = STATE.originalBuffer.map(function (t) { return t.text; }).join("").trim();
        if (!text) return false;
        var lastChar = text[text.length - 1];
        if (".?!。？！…\n".indexOf(lastChar) !== -1) return true;
        if (text.length > 60) return true;
        if (STATE.translatedBuffer.length > 0) {
            var tText = STATE.translatedBuffer.map(function (t) { return t.text; }).join("").trim();
            if (tText && ".?!。？！…\n".indexOf(tText[tText.length - 1]) !== -1) return true;
        }
        return false;
    }

    function flushToFirebase() {
        clearTimeout(STATE.flushTimer);
        if (STATE.originalBuffer.length === 0) return;

        var origText = STATE.originalBuffer.map(function (t) { return t.text; }).join("").trim();
        var transText = STATE.translatedBuffer.map(function (t) { return t.text; }).join("").trim();

        if (!origText) {
            STATE.originalBuffer = [];
            STATE.translatedBuffer = [];
            return;
        }

        var origLang = "vi";
        var transLang = "ja";
        if (STATE.originalBuffer.length > 0) {
            var detected = STATE.originalBuffer[0].language || "vi";
            if (detected === "vi" || detected === "ja") {
                origLang = detected;
                transLang = detected === "vi" ? "ja" : "vi";
            }
        }

        var msg = {
            sender: STATE.userName,
            originalLang: origLang,
            originalText: origText,
            translatedText: transText || origText,
            translatedLang: transLang,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        };

        STATE.originalBuffer = [];
        STATE.translatedBuffer = [];

        $("#transcription-preview").style.display = "none";

        if (STATE.currentRoomId) {
            STATE.db.ref("rooms/" + STATE.currentRoomId + "/messages").push(msg);
        }
    }

    function renderMessage(msg) {
        var container = $("#chat-messages");
        var chatContainer = $("#chat-container");
        var isSelf = msg.sender === STATE.userName;
        var display = getDisplayTexts(msg, STATE.targetLang);

        var group = document.createElement("div");
        group.className = "message-group";

        var header = document.createElement("div");
        header.className = "message-header";

        var nameSpan = document.createElement("span");
        nameSpan.className = "sender-name" + (isSelf ? " self" : "");
        nameSpan.textContent = msg.sender;

        var timeSpan = document.createElement("span");
        timeSpan.className = "message-time";
        timeSpan.textContent = formatTime(msg.timestamp || Date.now());

        header.appendChild(nameSpan);
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

        if (display.subtitleText && display.subtitleText !== display.mainText) {
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

        var isNewMessage = msg.timestamp && msg.timestamp > STATE.joinedAtTime;
        var isSameLang = msg.originalLang === STATE.targetLang;
        if (!isSelf && !msg.isTextOnly && display.ttsText && isNewMessage && !isSameLang) {
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
                ttsLang: ""
            };
        }
        if (msg.translatedLang === myTargetLang) {
            return {
                mainText: msg.translatedText || msg.originalText,
                subtitleText: msg.originalText,
                subtitleLang: msg.originalLang,
                ttsText: msg.translatedText || msg.originalText,
                ttsLang: msg.translatedLang
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
        STATE.ttsQueue.push({ text: text, lang: lang });
        if (!STATE.ttsPlaying) processTTSQueue();
    }

    function processTTSQueue() {
        if (STATE.ttsQueue.length === 0) {
            STATE.ttsPlaying = false;
            return;
        }

        STATE.ttsPlaying = true;
        var item = STATE.ttsQueue.shift();

        edgeTTS(item.text, item.lang)
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
        if (STATE.userCount < 2) return;

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
        $("#mic-status-text").textContent = "Recording...";
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
        $("#mic-status-text").textContent =
            STATE.userCount >= 2 ? "Hold to talk" : "Waiting for participants...";
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
        var keyInput = $("#soniox-key-input");
        var continueBtn = $("#setup-continue-btn");
        var toggleBtn = $("#toggle-key-btn");

        nameInput.value = STATE.userName;
        langSelect.value = STATE.targetLang;
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
                    await joinRoom(room.id, room.name);
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
            startRecording();
        });

        micBtn.addEventListener("mouseup", function () { stopRecording(); });
        micBtn.addEventListener("mouseleave", function () {
            if (STATE.isRecording) stopRecording();
        });

        micBtn.addEventListener("touchstart", function (e) {
            if (micBtn.disabled) return;
            e.preventDefault();
            startRecording();
        }, { passive: false });

        micBtn.addEventListener("touchend", function (e) {
            e.preventDefault();
            stopRecording();
        }, { passive: false });

        micBtn.addEventListener("touchcancel", function () {
            if (STATE.isRecording) stopRecording();
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
            STATE.ttsQueue = [];
            speechSynthesis.cancel();

            await loadRooms();
            showView("lobby-view");
            showToast("Left room", "info");
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

        if (STATE.userName && STATE.sonioxApiKey) {
            $("#user-name-input").value = STATE.userName;
            $("#target-lang-select").value = STATE.targetLang;
            $("#soniox-key-input").value = STATE.sonioxApiKey;
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
