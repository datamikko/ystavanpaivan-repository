(function () {
    "use strict";

    const panel = document.getElementById("remote-room-panel");
    if (!panel) {
        window.remoteRoom = {
            onLocalStateChange: function () {}
        };
        return;
    }

    const RTC_CONFIG = {
        iceServers: [
            {
                urls: [
                    "stun:stun.l.google.com:19302",
                    "stun:stun1.l.google.com:19302"
                ]
            }
        ]
    };
    const SIGNAL_VERSION = 1;
    const HANDSHAKE_TTL_MS = 10 * 60 * 1000;
    const HEART_STATES = new Set(["idle", "waiting", "friend", "heart"]);
    const NAME_STORAGE_KEY = "ystavanpaivaDisplayName";

    const state = {
        role: "solo",
        roomCode: "",
        roomSecret: "",
        hostId: "",
        localPeerId: randomToken(8),
        localState: inferLocalState(),
        pendingInvites: new Map(),
        hostPeers: new Map(),
        guestPeer: null,
        guestSnapshot: null
    };

    const ui = {
        headline: document.getElementById("remote-room-headline"),
        roomCode: document.getElementById("remote-room-code"),
        displayName: document.getElementById("remote-display-name"),
        createRoomBtn: document.getElementById("remote-create-room-btn"),
        createInviteBtn: document.getElementById("remote-create-invite-btn"),
        resetRoomBtn: document.getElementById("remote-reset-room-btn"),
        inviteOutput: document.getElementById("remote-invite-output"),
        copyInviteBtn: document.getElementById("remote-copy-invite-btn"),
        answerInput: document.getElementById("remote-answer-input"),
        applyAnswerBtn: document.getElementById("remote-apply-answer-btn"),
        joinBox: document.getElementById("remote-join-box"),
        answerOutput: document.getElementById("remote-answer-output"),
        copyAnswerBtn: document.getElementById("remote-copy-answer-btn"),
        status: document.getElementById("remote-status"),
        summary: document.getElementById("remote-summary"),
        participants: document.getElementById("remote-participants")
    };

    hydrateName();
    bindUi();
    renderAll();

    processHandshakeFromLocation().catch(function (error) {
        console.error("[RemoteRoom] Initial handshake parse failed:", error);
        setStatus("Could not process handshake link.", true);
    });

    window.addEventListener("hashchange", function () {
        processHandshakeFromLocation().catch(function (error) {
            console.error("[RemoteRoom] Hashchange handshake parse failed:", error);
            setStatus("Could not process handshake link.", true);
        });
    });

    window.remoteRoom = {
        onLocalStateChange: onLocalStateChange
    };

    function bindUi() {
        ui.createRoomBtn.addEventListener("click", createRoom);
        ui.createInviteBtn.addEventListener("click", function () {
            createInviteLink().catch(function (error) {
                console.error("[RemoteRoom] Create invite failed:", error);
                setStatus("Failed to generate invite link.", true);
            });
        });
        ui.resetRoomBtn.addEventListener("click", resetRoom);
        ui.applyAnswerBtn.addEventListener("click", function () {
            applyAnswerFromInput().catch(function (error) {
                console.error("[RemoteRoom] Apply answer failed:", error);
                setStatus(error.message || "Failed to apply answer link.", true);
            });
        });

        ui.copyInviteBtn.addEventListener("click", function () {
            copyValue(ui.inviteOutput.value, "Invite link copied.", "Create an invite link first.");
        });
        ui.copyAnswerBtn.addEventListener("click", function () {
            copyValue(ui.answerOutput.value, "Response link copied.", "Open an invite link first.");
        });

        ui.displayName.addEventListener("input", function () {
            ui.displayName.value = ui.displayName.value.slice(0, 24);
            persistName();
            announceIdentity();
            if (state.role === "host") {
                broadcastRoomSnapshot();
            }
            renderAll();
        });
    }

    function hydrateName() {
        try {
            const stored = localStorage.getItem(NAME_STORAGE_KEY);
            if (stored) {
                ui.displayName.value = stored.slice(0, 24);
            }
        } catch (error) {
            console.warn("[RemoteRoom] Could not read saved display name:", error);
        }
    }

    function persistName() {
        try {
            localStorage.setItem(NAME_STORAGE_KEY, getLocalName());
        } catch (error) {
            console.warn("[RemoteRoom] Could not persist display name:", error);
        }
    }

    function getLocalName() {
        const value = (ui.displayName.value || "").trim();
        return value ? value.slice(0, 24) : "Friend";
    }

    function inferLocalState() {
        if (document.body.classList.contains("state-heart")) return "heart";
        if (document.body.classList.contains("state-friend")) return "friend";
        if (document.body.classList.contains("state-waiting")) return "waiting";
        return "idle";
    }

    function onLocalStateChange(nextState) {
        const normalized = normalizeState(nextState);
        if (state.localState === normalized) {
            return;
        }

        state.localState = normalized;
        broadcastLocalState();
        if (state.role === "host") {
            broadcastRoomSnapshot();
        }
        renderParticipants();
    }

    function normalizeState(value) {
        return HEART_STATES.has(value) ? value : "waiting";
    }

    function randomToken(length) {
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const bytes = new Uint8Array(length);
        crypto.getRandomValues(bytes);
        let out = "";
        for (let i = 0; i < length; i++) {
            out += alphabet[bytes[i] % alphabet.length];
        }
        return out;
    }

    function setHeadline(text) {
        ui.headline.textContent = text;
    }

    function setStatus(text, isError) {
        ui.status.textContent = text;
        ui.status.classList.toggle("remote-error", !!isError);
    }

    function updateRoomCodeLine() {
        ui.roomCode.textContent = state.roomCode ? ("Room code: " + state.roomCode) : "Room code: -";
    }

    function renderAll() {
        renderControls();
        renderParticipants();
    }

    function renderControls() {
        const isHost = state.role === "host";
        const isGuest = state.role === "guest";

        ui.createInviteBtn.disabled = !isHost;
        ui.applyAnswerBtn.disabled = !isHost;
        ui.answerInput.disabled = !isHost;
        ui.resetRoomBtn.disabled = !(isHost || isGuest);
        ui.copyInviteBtn.disabled = !ui.inviteOutput.value.trim();
        ui.copyAnswerBtn.disabled = !ui.answerOutput.value.trim();
        ui.joinBox.classList.toggle("remote-hidden", state.role !== "guest");

        updateRoomCodeLine();
    }

    function renderParticipants() {
        let participants = [];

        if (state.role === "host") {
            participants = collectHostParticipants();
            const connected = participants.filter(function (p) {
                return p.status === "open" && !p.isHost;
            }).length;
            const pending = participants.filter(function (p) {
                return p.state === "pending";
            }).length;
            const hearts = participants.filter(function (p) {
                return p.state === "heart" && !p.isHost;
            }).length;
            ui.summary.textContent = "Room " + state.roomCode + ": " + (connected + 1) + " connected, " + hearts + " remote heart(s), " + pending + " pending invite(s).";
        } else if (state.role === "guest") {
            participants = collectGuestParticipants();
            const remoteHearts = participants.filter(function (p) {
                return p.state === "heart" && p.id !== state.localPeerId;
            }).length;
            const connectedToHost = !!(state.guestPeer && state.guestPeer.channel && state.guestPeer.channel.readyState === "open");
            ui.summary.textContent = connectedToHost
                ? ("Connected to room " + state.roomCode + ". Remote heart(s): " + remoteHearts + ".")
                : ("Room " + state.roomCode + ": response ready, waiting for host to apply it.");
        } else {
            participants = [{
                id: state.localPeerId,
                name: getLocalName() + " (You)",
                state: state.localState,
                status: "local",
                isHost: false
            }];
            ui.summary.textContent = "Participants: just you.";
        }

        ui.participants.innerHTML = "";
        participants.forEach(function (participant) {
            const item = document.createElement("li");
            item.classList.add("state-" + (participant.state || "waiting"));
            item.textContent = participant.name + " - " + formatState(participant.state) + " (" + (participant.status || "connected") + ")";
            ui.participants.appendChild(item);
        });
    }

    function formatState(value) {
        if (value === "heart") return "heart";
        if (value === "friend") return "friend";
        if (value === "idle") return "idle";
        if (value === "pending") return "pending";
        return "waiting";
    }

    function collectHostParticipants() {
        const participants = [{
            id: state.localPeerId,
            name: getLocalName() + " (Host)",
            state: state.localState,
            status: "open",
            isHost: true
        }];

        state.hostPeers.forEach(function (context, inviteId) {
            participants.push({
                id: context.remotePeerId || inviteId,
                name: context.remoteName || ("Friend " + inviteId),
                state: context.remoteState || "waiting",
                status: context.channel ? context.channel.readyState : "connecting",
                isHost: false
            });
        });

        state.pendingInvites.forEach(function (context, inviteId) {
            participants.push({
                id: inviteId,
                name: context.remoteName || ("Invite " + inviteId),
                state: "pending",
                status: "awaiting answer",
                isHost: false
            });
        });

        return participants;
    }

    function collectGuestParticipants() {
        const participants = [];

        if (state.guestSnapshot && Array.isArray(state.guestSnapshot.participants)) {
            state.guestSnapshot.participants.forEach(function (participant) {
                participants.push({
                    id: participant.id || randomToken(4),
                    name: participant.name || "Friend",
                    state: normalizeState(participant.state),
                    status: participant.status || "open",
                    isHost: /\(Host\)$/.test(participant.name || "")
                });
            });
        } else {
            participants.push({
                id: state.localPeerId,
                name: getLocalName() + " (You)",
                state: state.localState,
                status: "local",
                isHost: false
            });

            participants.push({
                id: state.hostId || "HOST",
                name: state.guestPeer && state.guestPeer.remoteName ? (state.guestPeer.remoteName + " (Host)") : "Host",
                state: state.guestPeer ? state.guestPeer.remoteState : "waiting",
                status: state.guestPeer && state.guestPeer.channel ? state.guestPeer.channel.readyState : "connecting",
                isHost: true
            });
        }

        const hasLocal = participants.some(function (participant) {
            return participant.id === state.localPeerId;
        });

        if (!hasLocal) {
            participants.push({
                id: state.localPeerId,
                name: getLocalName() + " (You)",
                state: state.localState,
                status: "open",
                isHost: false
            });
        }

        return participants;
    }
    function createRoom() {
        teardownConnections();
        state.role = "host";
        state.roomCode = randomToken(6);
        state.roomSecret = randomToken(18);
        state.hostId = state.localPeerId;
        state.guestSnapshot = null;

        ui.inviteOutput.value = "";
        ui.answerInput.value = "";
        ui.answerOutput.value = "";

        setHeadline("Hosting room " + state.roomCode + ". Generate invite links, then apply answer links.");
        setStatus("Room " + state.roomCode + " ready. Generate an invite link.", false);
        renderAll();
    }

    function resetRoom() {
        teardownConnections();
        state.role = "solo";
        state.roomCode = "";
        state.roomSecret = "";
        state.hostId = "";
        state.guestSnapshot = null;

        ui.inviteOutput.value = "";
        ui.answerInput.value = "";
        ui.answerOutput.value = "";

        setHeadline("Create a room to invite remote friends.");
        setStatus("No active WebRTC room.", false);
        renderAll();
    }

    function teardownConnections() {
        const unique = new Set();
        state.pendingInvites.forEach(function (context) {
            unique.add(context);
        });
        state.hostPeers.forEach(function (context) {
            unique.add(context);
        });
        if (state.guestPeer) {
            unique.add(state.guestPeer);
        }

        unique.forEach(function (context) {
            closePeerContext(context);
        });

        state.pendingInvites.clear();
        state.hostPeers.clear();
        state.guestPeer = null;
        state.guestSnapshot = null;
    }

    function closePeerContext(context) {
        if (!context || context.closed) {
            return;
        }
        context.closed = true;

        try {
            if (context.channel && context.channel.readyState !== "closed") {
                context.channel.close();
            }
        } catch (error) {
            console.warn("[RemoteRoom] Channel close warning:", error);
        }

        try {
            context.pc.close();
        } catch (error) {
            console.warn("[RemoteRoom] Peer close warning:", error);
        }
    }

    function removeContext(context) {
        if (!context) return;

        if (state.pendingInvites.get(context.inviteId) === context) {
            state.pendingInvites.delete(context.inviteId);
        }
        if (state.hostPeers.get(context.inviteId) === context) {
            state.hostPeers.delete(context.inviteId);
        }
        if (state.guestPeer === context) {
            state.guestPeer = null;
        }
    }

    function createBasePeerContext(inviteId) {
        const pc = new RTCPeerConnection(RTC_CONFIG);
        const context = {
            inviteId: inviteId,
            pc: pc,
            channel: null,
            remotePeerId: "",
            remoteName: "",
            remoteState: "waiting",
            closed: false
        };

        pc.addEventListener("connectionstatechange", function () {
            if (pc.connectionState === "failed") {
                removeContext(context);
                closePeerContext(context);
                setStatus("WebRTC connection failed. Generate a fresh invite.", true);
                if (state.role === "host") {
                    broadcastRoomSnapshot();
                }
                renderAll();
            }
        });

        return context;
    }

    function attachDataChannel(context, channel) {
        context.channel = channel;

        channel.addEventListener("open", function () {
            sendHello(context);
            sendLocalState(context);

            if (state.role === "host") {
                setStatus("Participant connected in room " + state.roomCode + ".", false);
                broadcastRoomSnapshot();
            } else {
                setStatus("Connected to host in room " + state.roomCode + ".", false);
            }
            renderAll();
        });

        channel.addEventListener("message", function (event) {
            handlePeerMessage(context, event.data);
        });

        channel.addEventListener("close", function () {
            removeContext(context);
            if (state.role === "host") {
                setStatus("A participant disconnected.", false);
                broadcastRoomSnapshot();
            } else {
                setStatus("Connection to host closed.", true);
            }
            renderAll();
        });

        channel.addEventListener("error", function (error) {
            console.error("[RemoteRoom] DataChannel error:", error);
        });
    }

    async function createInviteLink() {
        if (state.role !== "host") {
            setStatus("Create a room before generating invites.", true);
            return;
        }

        const inviteId = randomToken(8);
        const context = createBasePeerContext(inviteId);
        const channel = context.pc.createDataChannel("heart-room", { ordered: true });

        attachDataChannel(context, channel);
        state.pendingInvites.set(inviteId, context);

        try {
            const offer = await context.pc.createOffer();
            await context.pc.setLocalDescription(offer);
            await waitForIceGatheringComplete(context.pc, 12000);

            const payload = {
                v: SIGNAL_VERSION,
                kind: "offer",
                roomCode: state.roomCode,
                roomSecret: state.roomSecret,
                inviteId: inviteId,
                hostId: state.localPeerId,
                hostName: getLocalName(),
                exp: Date.now() + HANDSHAKE_TTL_MS,
                sdpType: context.pc.localDescription.type,
                sdp: context.pc.localDescription.sdp
            };

            ui.inviteOutput.value = buildLink("offer", payload);
            setStatus("Invite " + inviteId + " ready. Send it to your friend.", false);
            renderAll();
        } catch (error) {
            state.pendingInvites.delete(inviteId);
            closePeerContext(context);
            throw error;
        }
    }

    async function applyAnswerFromInput() {
        if (state.role !== "host") {
            setStatus("Only the host can apply answer links.", true);
            return;
        }

        const token = parseTokenFromText(ui.answerInput.value, "answer");
        if (!token) {
            setStatus("Paste an answer link first.", true);
            return;
        }

        await applyAnswerToken(token);
        ui.answerInput.value = "";
        renderAll();
    }

    async function applyAnswerToken(rawToken) {
        const payload = decodeAndValidateToken(rawToken, "answer");

        if (payload.roomCode !== state.roomCode) {
            throw new Error("Answer is for room " + payload.roomCode + ", but host room is " + state.roomCode + ".");
        }
        if (payload.roomSecret !== state.roomSecret) {
            throw new Error("Answer token secret mismatch. Ask friend to regenerate from latest invite.");
        }

        const context = state.pendingInvites.get(payload.inviteId);
        if (!context) {
            throw new Error("No pending invite found for this answer. Generate a new invite.");
        }

        context.remotePeerId = payload.guestId || "";
        context.remoteName = payload.guestName || context.remoteName || ("Friend " + payload.inviteId);

        await context.pc.setRemoteDescription({
            type: payload.sdpType || "answer",
            sdp: payload.sdp
        });

        state.pendingInvites.delete(payload.inviteId);
        state.hostPeers.set(payload.inviteId, context);
        setStatus("Answer applied for invite " + payload.inviteId + ". Waiting for channel open...", false);
        renderAll();
    }

    async function joinFromOfferToken(rawToken) {
        const payload = decodeAndValidateToken(rawToken, "offer");

        if (state.role === "host" && (state.hostPeers.size > 0 || state.pendingInvites.size > 0)) {
            throw new Error("You are already hosting active participants. Reset room before joining another invite.");
        }

        teardownConnections();
        state.role = "guest";
        state.roomCode = payload.roomCode;
        state.roomSecret = payload.roomSecret;
        state.hostId = payload.hostId || "";
        state.guestSnapshot = null;

        ui.answerOutput.value = "";
        setHeadline("Joining room " + state.roomCode + ". Create your response link and send it back to host.");
        setStatus("Invite detected. Generating response link...", false);
        renderAll();

        const context = createBasePeerContext(payload.inviteId);
        context.remoteName = payload.hostName || "Host";
        state.guestPeer = context;

        context.pc.addEventListener("datachannel", function (event) {
            attachDataChannel(context, event.channel);
        });

        await context.pc.setRemoteDescription({
            type: payload.sdpType || "offer",
            sdp: payload.sdp
        });

        const answer = await context.pc.createAnswer();
        await context.pc.setLocalDescription(answer);
        await waitForIceGatheringComplete(context.pc, 12000);

        const answerPayload = {
            v: SIGNAL_VERSION,
            kind: "answer",
            roomCode: payload.roomCode,
            roomSecret: payload.roomSecret,
            inviteId: payload.inviteId,
            guestId: state.localPeerId,
            guestName: getLocalName(),
            exp: Date.now() + HANDSHAKE_TTL_MS,
            sdpType: context.pc.localDescription.type,
            sdp: context.pc.localDescription.sdp
        };

        ui.answerOutput.value = buildLink("answer", answerPayload);
        setStatus("Response link ready for room " + state.roomCode + ". Send it to host.", false);
        renderAll();
    }
    function sendMessage(context, payload) {
        if (!context || !context.channel || context.channel.readyState !== "open") {
            return false;
        }

        try {
            context.channel.send(JSON.stringify(payload));
            return true;
        } catch (error) {
            console.error("[RemoteRoom] Send message failed:", error);
            return false;
        }
    }

    function sendHello(context) {
        sendMessage(context, {
            type: "hello",
            peerId: state.localPeerId,
            name: getLocalName(),
            roomCode: state.roomCode,
            role: state.role,
            at: Date.now()
        });
    }

    function sendLocalState(context) {
        sendMessage(context, {
            type: "heart-state",
            state: state.localState,
            at: Date.now()
        });
    }

    function broadcastLocalState() {
        if (state.role === "host") {
            state.hostPeers.forEach(function (context) {
                sendLocalState(context);
            });
        } else if (state.role === "guest" && state.guestPeer) {
            sendLocalState(state.guestPeer);
        }
    }

    function announceIdentity() {
        if (state.role === "host") {
            state.hostPeers.forEach(function (context) {
                sendHello(context);
            });
        } else if (state.role === "guest" && state.guestPeer) {
            sendHello(state.guestPeer);
        }
    }

    function buildRoomSnapshot() {
        const participants = [{
            id: state.localPeerId,
            name: getLocalName() + " (Host)",
            state: state.localState,
            status: "open"
        }];

        state.hostPeers.forEach(function (context, inviteId) {
            participants.push({
                id: context.remotePeerId || inviteId,
                name: context.remoteName || ("Friend " + inviteId),
                state: context.remoteState || "waiting",
                status: context.channel ? context.channel.readyState : "connecting"
            });
        });

        return {
            roomCode: state.roomCode,
            participants: participants,
            updatedAt: Date.now()
        };
    }

    function broadcastRoomSnapshot() {
        if (state.role !== "host") {
            return;
        }

        const snapshot = buildRoomSnapshot();

        state.hostPeers.forEach(function (context) {
            sendMessage(context, {
                type: "room-state",
                snapshot: snapshot
            });
        });

        renderParticipants();
    }

    function handlePeerMessage(context, rawData) {
        let payload;
        try {
            payload = JSON.parse(rawData);
        } catch (error) {
            console.warn("[RemoteRoom] Ignoring non-JSON message:", rawData);
            return;
        }

        if (!payload || typeof payload !== "object") {
            return;
        }

        if (payload.type === "hello") {
            context.remotePeerId = typeof payload.peerId === "string" ? payload.peerId : context.remotePeerId;
            context.remoteName = typeof payload.name === "string" && payload.name.trim()
                ? payload.name.trim().slice(0, 24)
                : context.remoteName;

            if (state.role === "host") {
                broadcastRoomSnapshot();
            }
            renderParticipants();
            return;
        }

        if (payload.type === "heart-state") {
            context.remoteState = normalizeState(payload.state);
            if (state.role === "host") {
                broadcastRoomSnapshot();
            }
            renderParticipants();
            return;
        }

        if (payload.type === "room-state" && state.role === "guest") {
            if (payload.snapshot && Array.isArray(payload.snapshot.participants)) {
                state.guestSnapshot = payload.snapshot;
                renderParticipants();
            }
        }
    }

    function copyValue(rawValue, successMessage, emptyMessage) {
        const value = (rawValue || "").trim();
        if (!value) {
            setStatus(emptyMessage, true);
            return;
        }

        copyText(value).then(function (copied) {
            if (copied) {
                setStatus(successMessage, false);
            } else {
                setStatus("Clipboard blocked. Copy manually from text area.", true);
            }
        });
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (error) {
            const helper = document.createElement("textarea");
            helper.value = text;
            helper.setAttribute("readonly", "true");
            helper.style.position = "absolute";
            helper.style.left = "-9999px";
            document.body.appendChild(helper);
            helper.select();
            const success = document.execCommand("copy");
            document.body.removeChild(helper);
            return success;
        }
    }

    function buildLink(key, payload) {
        const token = encodePayload(payload);
        return window.location.origin + window.location.pathname + "#" + key + "=" + encodeURIComponent(token);
    }

    function parseTokenFromText(input, key) {
        const raw = (input || "").trim();
        if (!raw) {
            return "";
        }

        if (raw.startsWith(key + "=")) {
            return raw.slice(key.length + 1).trim();
        }

        try {
            const parsedUrl = new URL(raw, window.location.href);
            const hash = parsedUrl.hash.startsWith("#") ? parsedUrl.hash.slice(1) : parsedUrl.hash;
            const hashParams = new URLSearchParams(hash);
            const hashToken = hashParams.get(key);
            if (hashToken) {
                return hashToken;
            }

            const queryToken = parsedUrl.searchParams.get(key);
            if (queryToken) {
                return queryToken;
            }
        } catch (error) {
            // Input was not a URL.
        }

        if (raw.includes("#")) {
            const hashOnly = raw.split("#").pop() || "";
            const hashParams = new URLSearchParams(hashOnly);
            const token = hashParams.get(key);
            if (token) {
                return token;
            }
        }

        return raw;
    }

    function encodePayload(payload) {
        const json = JSON.stringify(payload);
        const bytes = new TextEncoder().encode(json);
        let binary = "";
        bytes.forEach(function (byte) {
            binary += String.fromCharCode(byte);
        });

        return btoa(binary)
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
    }

    function decodePayload(token) {
        const normalized = token.replace(/-/g, "+").replace(/_/g, "/");
        const padLen = (4 - (normalized.length % 4)) % 4;
        const padded = normalized + "=".repeat(padLen);
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, function (char) {
            return char.charCodeAt(0);
        });
        return JSON.parse(new TextDecoder().decode(bytes));
    }

    function safeDecodeURIComponent(raw) {
        try {
            return decodeURIComponent(raw);
        } catch (error) {
            return raw;
        }
    }

    function decodeAndValidateToken(rawToken, expectedKind) {
        const decodedToken = safeDecodeURIComponent((rawToken || "").trim());
        const payload = decodePayload(decodedToken);

        if (!payload || typeof payload !== "object") {
            throw new Error("Handshake payload is invalid.");
        }
        if (payload.v !== SIGNAL_VERSION) {
            throw new Error("Unsupported handshake payload version.");
        }
        if (payload.kind !== expectedKind) {
            throw new Error("Expected " + expectedKind + " payload, received " + (payload.kind || "unknown") + ".");
        }
        if (typeof payload.roomCode !== "string" || !payload.roomCode) {
            throw new Error("Missing room code in handshake payload.");
        }
        if (typeof payload.roomSecret !== "string" || !payload.roomSecret) {
            throw new Error("Missing room secret in handshake payload.");
        }
        if (typeof payload.inviteId !== "string" || !payload.inviteId) {
            throw new Error("Missing invite id in handshake payload.");
        }
        if (typeof payload.sdp !== "string" || !payload.sdp) {
            throw new Error("Missing SDP in handshake payload.");
        }
        if (payload.exp && Date.now() > payload.exp) {
            throw new Error("Handshake link expired. Generate a fresh invite.");
        }

        return payload;
    }

    function waitForIceGatheringComplete(pc, timeoutMs) {
        if (pc.iceGatheringState === "complete") {
            return Promise.resolve();
        }

        return new Promise(function (resolve) {
            let done = false;
            const timeout = setTimeout(finish, timeoutMs);

            function finish() {
                if (done) {
                    return;
                }
                done = true;
                clearTimeout(timeout);
                pc.removeEventListener("icegatheringstatechange", onStateChange);
                resolve();
            }

            function onStateChange() {
                if (pc.iceGatheringState === "complete") {
                    finish();
                }
            }

            pc.addEventListener("icegatheringstatechange", onStateChange);
        });
    }

    async function processHandshakeFromLocation() {
        const hash = window.location.hash.startsWith("#")
            ? window.location.hash.slice(1)
            : window.location.hash;

        if (!hash) {
            return;
        }

        const params = new URLSearchParams(hash);
        const offerToken = params.get("offer");
        const answerToken = params.get("answer");

        if (!offerToken && !answerToken) {
            return;
        }

        if (offerToken) {
            try {
                await joinFromOfferToken(offerToken);
            } catch (error) {
                console.error("[RemoteRoom] Join from offer failed:", error);
                setStatus(error.message || "Could not join from invite link.", true);
            }
            clearLocationHash();
            return;
        }

        if (answerToken) {
            ui.answerInput.value = window.location.origin + window.location.pathname + "#answer=" + encodeURIComponent(answerToken);
            if (state.role === "host") {
                try {
                    await applyAnswerToken(answerToken);
                    ui.answerInput.value = "";
                } catch (error) {
                    console.error("[RemoteRoom] Auto apply answer failed:", error);
                    setStatus(error.message || "Could not auto-apply answer link.", true);
                }
            } else {
                setStatus("Answer link detected. Paste it into the host room tab.", false);
            }
            renderAll();
            clearLocationHash();
        }
    }

    function clearLocationHash() {
        if (!window.location.hash) {
            return;
        }

        history.replaceState(null, "", window.location.pathname + window.location.search);
    }
})();
