"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const PARTNERS = [
  { code: "zh", label: "중국어" },
  { code: "ja", label: "일본어" },
  { code: "fr", label: "프랑스어" },
  { code: "de", label: "독일어" },
  { code: "pt", label: "포르투갈어" },
  { code: "en", label: "영어" },
];

const PARTNER_LABEL = Object.fromEntries(
  PARTNERS.map((p) => [p.code, p.label])
);

const STATUS = {
  idle: { text: "대기 중", color: "#8a8880" },
  connecting: { text: "연결 중…", color: "#ffd43b" },
  live: { text: "통역 중", color: "#00d4aa" },
  error: { text: "연결 오류", color: "#ff6b6b" },
};

const HANGUL = /[가-힯ᄀ-ᇿ㄰-㆏]/;
const MEANINGFUL = /[^\s.,!?。、！？·…]/;

const DIRECTIONS = ["toPartner", "toKo"];

const OUTPUT_GAIN = 3.0;
const MIC_GAIN = 1.5;

export default function Page() {
  const [partner, setPartner] = useState("ja");
  const [status, setStatus] = useState("idle");
  const [activeDir, setActiveDir] = useState("toPartner");
  const [lines, setLines] = useState([]);
  const [partial, setPartial] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const pcsRef = useRef({});
  const dcsRef = useRef({});
  const micRef = useRef(null);
  const audioPartnerRef = useRef(null);
  const audioKoRef = useRef(null);
  const inputBufRef = useRef({});
  const activeDirRef = useRef("toPartner");
  const convoRef = useRef(null);
  const audioCtxRef = useRef(null);
  const gainNodesRef = useRef({});
  const nodesRef = useRef({});
  const sendStreamRef = useRef(null);

  const live = status === "live";
  const connecting = status === "connecting";
  const busy = live || connecting;

  const partnerLabel = PARTNER_LABEL[partner];

  const stop = useCallback(() => {
    for (const dir of DIRECTIONS) {
      const dc = dcsRef.current[dir];
      dcsRef.current[dir] = null;
      if (dc) {
        try {
          dc.close();
        } catch {}
      }
      const pc = pcsRef.current[dir];
      pcsRef.current[dir] = null;
      if (pc) {
        try {
          pc.close();
        } catch {}
      }
    }
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch {}
      audioCtxRef.current = null;
    }
    gainNodesRef.current = {};
    nodesRef.current = {};
    sendStreamRef.current = null;
    for (const el of [audioPartnerRef.current, audioKoRef.current]) {
      if (el) el.srcObject = null;
    }
    if (micRef.current) {
      micRef.current.getTracks().forEach((t) => t.stop());
      micRef.current = null;
    }
    setStatus("idle");
  }, []);

  useEffect(() => () => stop(), [stop]);

  useEffect(() => {
    const g = gainNodesRef.current;
    if (g.toPartner) {
      g.toPartner.gain.value = activeDir === "toPartner" ? OUTPUT_GAIN : 0;
    }
    if (g.toKo) {
      g.toKo.gain.value = activeDir === "toKo" ? OUTPUT_GAIN : 0;
    }
  }, [activeDir]);

  useEffect(() => {
    if (convoRef.current) {
      convoRef.current.scrollTop = convoRef.current.scrollHeight;
    }
  }, [lines, partial]);

  function routeByInput(text) {
    let dir = null;
    if (HANGUL.test(text)) dir = "toPartner";
    else if (MEANINGFUL.test(text)) dir = "toKo";
    if (!dir || dir === activeDirRef.current) return;

    setPartial((prev) => {
      const trimmed = prev.trim();
      if (trimmed) {
        const from = activeDirRef.current;
        setLines((ls) => [...ls, { dir: from, text: trimmed }].slice(-50));
      }
      return "";
    });
    activeDirRef.current = dir;
    setActiveDir(dir);
  }

  function handleEvent(direction, raw) {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const t = event.type;

    if (t === "session.input_transcript.delta") {
      inputBufRef.current[direction] =
        (inputBufRef.current[direction] || "") + (event.delta || "");
      routeByInput(inputBufRef.current[direction]);
    } else if (
      t === "session.input_transcript.done" ||
      t === "session.input_transcript.completed"
    ) {
      inputBufRef.current[direction] = "";
    } else if (t === "session.output_transcript.delta") {
      if (direction !== activeDirRef.current) return;
      setPartial((p) => p + (event.delta || ""));
    } else if (
      t === "session.output_transcript.done" ||
      t === "session.output_transcript.completed"
    ) {
      if (direction !== activeDirRef.current) return;
      const finalText = (event.transcript || "").trim();
      setPartial((p) => {
        const text = finalText || p.trim();
        if (text) {
          setLines((ls) => [...ls, { dir: direction, text }].slice(-50));
        }
        return "";
      });
    } else if (t === "error") {
      setErrorMsg(event.error?.message || "통역 중 오류가 발생했습니다.");
    }
  }

  async function connectSession(direction, language) {
    const tokenRes = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language }),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.json().catch(() => ({}));
      throw new Error(body.error || "세션 생성에 실패했습니다.");
    }
    const { client_secret: clientSecret } = await tokenRes.json();
    if (!clientSecret) throw new Error("토큰을 받지 못했습니다.");

    const pc = new RTCPeerConnection();
    pcsRef.current[direction] = pc;

    pc.ontrack = ({ streams }) => {
      const stream = streams[0];
      const el =
        direction === "toPartner"
          ? audioPartnerRef.current
          : audioKoRef.current;
      if (el) {
        el.srcObject = stream;
        el.muted = true;
        el.play().catch(() => {});
      }
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = activeDirRef.current === direction ? OUTPUT_GAIN : 0;
      const compressor = ctx.createDynamicsCompressor();
      source.connect(gain);
      gain.connect(compressor);
      compressor.connect(ctx.destination);
      gainNodesRef.current[direction] = gain;
      nodesRef.current[direction] = { source, gain, compressor };
    };

    pc.onconnectionstatechange = () => {
      if (pcsRef.current[direction] !== pc) return;
      const s = pc.connectionState;
      if (s === "connected") {
        const other = direction === "toPartner" ? "toKo" : "toPartner";
        const op = pcsRef.current[other];
        if (op && op.connectionState === "connected") setStatus("live");
      }
      if (s === "failed" || s === "disconnected" || s === "closed") {
        setErrorMsg("연결이 끊어졌습니다. 다시 시도해 주세요.");
        stop();
        setStatus("error");
      }
    };

    const dc = pc.createDataChannel("oai-events");
    dcsRef.current[direction] = dc;
    dc.onmessage = ({ data }) => handleEvent(direction, data);

    const sendStream = sendStreamRef.current || micRef.current;
    for (const track of sendStream.getAudioTracks()) {
      pc.addTrack(track, sendStream);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpRes = await fetch(
      "https://api.openai.com/v1/realtime/translations/calls",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      }
    );
    if (!sdpRes.ok) throw new Error("OpenAI 연결에 실패했습니다.");

    await pc.setRemoteDescription({
      type: "answer",
      sdp: await sdpRes.text(),
    });
  }

  async function start() {
    setErrorMsg("");
    setLines([]);
    setPartial("");
    setStatus("connecting");
    activeDirRef.current = "toPartner";
    setActiveDir("toPartner");
    inputBufRef.current = {};

    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micRef.current = mic;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();

      const micSource = ctx.createMediaStreamSource(mic);
      const micGain = ctx.createGain();
      micGain.gain.value = MIC_GAIN;
      const micDest = ctx.createMediaStreamDestination();
      micSource.connect(micGain);
      micGain.connect(micDest);
      nodesRef.current.mic = { micSource, micGain, micDest };
      sendStreamRef.current = micDest.stream;

      await Promise.all([
        connectSession("toPartner", partner),
        connectSession("toKo", "ko"),
      ]);
    } catch (err) {
      setErrorMsg(err?.message || "연결에 실패했습니다.");
      stop();
      setStatus("error");
    }
  }

  const st = STATUS[status];
  const fromLabel = activeDir === "toPartner" ? "한국어" : partnerLabel;
  const toLabel = activeDir === "toPartner" ? partnerLabel : "한국어";

  function tagLabel(dir) {
    return dir === "toPartner" ? partnerLabel : "한국어";
  }

  return (
    <main className="app">
      <header className="head">
        <h1>동시통역기</h1>
        <div className="status">
          <span className="dot" style={{ background: st.color }} />
          <span style={{ color: st.color }}>{st.text}</span>
        </div>
      </header>

      <p className="picker-label">한국어 ↔ 통역할 언어 선택</p>
      <div className="lang-grid">
        {PARTNERS.map((p) => (
          <button
            key={p.code}
            className={`chip ${partner === p.code ? "chip-on" : ""}`}
            onClick={() => !busy && setPartner(p.code)}
            disabled={busy}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="dir-bar">
        <span>실시간 자동 통역</span>
        <span className="sep">·</span>
        <strong>
          {fromLabel} → {toLabel}
        </strong>
      </div>

      <section className="convo" ref={convoRef}>
        {lines.length === 0 && !partial && (
          <p className="placeholder">
            시작 버튼을 누르고 대화하세요.
            <br />
            한국어와 {partnerLabel}를 자동으로 통역합니다.
          </p>
        )}
        {lines.map((line, i) => (
          <div key={i} className="line">
            <span className={`tag tag-${line.dir}`}>{tagLabel(line.dir)}</span>
            <span className="line-text">{line.text}</span>
          </div>
        ))}
        {partial && (
          <div className="line line-partial">
            <span className={`tag tag-${activeDir}`}>{tagLabel(activeDir)}</span>
            <span className="line-text">{partial}</span>
          </div>
        )}
      </section>

      {errorMsg && <p className="error">{errorMsg}</p>}

      <button
        className={`mic ${live ? "mic-on" : ""}`}
        onClick={busy ? stop : start}
      >
        {live ? "정지" : connecting ? "연결 중… (탭하여 취소)" : "시작"}
      </button>

      <audio ref={audioPartnerRef} autoPlay muted playsInline />
      <audio ref={audioKoRef} autoPlay muted playsInline />
    </main>
  );
}
