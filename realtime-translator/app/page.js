"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const PAIRS = {
  ja: { label: "한국어 ↔ 일본어" },
  en: { label: "한국어 ↔ 영어" },
};

const LANG_LABEL = { ko: "한국어", ja: "일본어", en: "영어" };

const STATUS = {
  idle: { text: "대기 중", color: "#8a8880" },
  connecting: { text: "연결 중…", color: "#ffd43b" },
  live: { text: "통역 중", color: "#00d4aa" },
  error: { text: "연결 오류", color: "#ff6b6b" },
};

export default function Page() {
  const [pair, setPair] = useState("ja");
  const [target, setTarget] = useState("ja");
  const [status, setStatus] = useState("idle");
  const [lines, setLines] = useState([]);
  const [partial, setPartial] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const micRef = useRef(null);
  const audioRef = useRef(null);
  const subtitleRef = useRef(null);

  const live = status === "live";
  const connecting = status === "connecting";
  const busy = live || connecting;

  function selectPair(key) {
    if (busy) return;
    setPair(key);
    setTarget(key);
  }

  function swapDirection() {
    if (busy) return;
    setTarget((t) => (t === "ko" ? pair : "ko"));
  }

  const stop = useCallback(() => {
    if (dcRef.current) {
      try {
        dcRef.current.close();
      } catch {}
      dcRef.current = null;
    }
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {}
      pcRef.current = null;
    }
    if (micRef.current) {
      micRef.current.getTracks().forEach((t) => t.stop());
      micRef.current = null;
    }
    setStatus("idle");
  }, []);

  useEffect(() => () => stop(), [stop]);

  async function start() {
    setErrorMsg("");
    setLines([]);
    setPartial("");
    setStatus("connecting");

    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      micRef.current = mic;

      const tokenRes = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: target }),
      });
      if (!tokenRes.ok) {
        const body = await tokenRes.json().catch(() => ({}));
        throw new Error(body.error || "세션 생성에 실패했습니다.");
      }
      const { client_secret: clientSecret } = await tokenRes.json();
      if (!clientSecret) throw new Error("토큰을 받지 못했습니다.");

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      pc.ontrack = ({ streams }) => {
        if (audioRef.current) audioRef.current.srcObject = streams[0];
      };

      pc.onconnectionstatechange = () => {
        if (pcRef.current !== pc) return;
        const s = pc.connectionState;
        if (s === "connected") setStatus("live");
        if (s === "failed" || s === "disconnected" || s === "closed") {
          setErrorMsg("연결이 끊어졌습니다. 다시 시도해 주세요.");
          stop();
          setStatus("error");
        }
      };

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onmessage = ({ data }) => {
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        if (event.type === "session.output_transcript.delta") {
          setPartial((p) => p + (event.delta || ""));
        } else if (
          event.type === "session.output_transcript.done" ||
          event.type === "session.output_transcript.completed"
        ) {
          setPartial((p) => {
            const finalText = (event.transcript || p || "").trim();
            if (finalText) setLines((ls) => [...ls, finalText].slice(-30));
            return "";
          });
        } else if (event.type === "error") {
          setErrorMsg(event.error?.message || "통역 중 오류가 발생했습니다.");
        }
      };

      for (const track of mic.getAudioTracks()) {
        pc.addTrack(track, mic);
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
    } catch (err) {
      setErrorMsg(err?.message || "연결에 실패했습니다.");
      stop();
      setStatus("error");
    }
  }

  useEffect(() => {
    if (subtitleRef.current) {
      subtitleRef.current.scrollTop = subtitleRef.current.scrollHeight;
    }
  }, [lines, partial]);

  const st = STATUS[status];
  const sourceLang = target === "ko" ? LANG_LABEL[pair] : "한국어";

  return (
    <main className="app">
      <header className="head">
        <h1>실시간 통역기</h1>
        <div className="status">
          <span className="dot" style={{ background: st.color }} />
          <span style={{ color: st.color }}>{st.text}</span>
        </div>
      </header>

      <section className="controls">
        <div className="pair-row">
          {Object.entries(PAIRS).map(([key, p]) => (
            <button
              key={key}
              className={`chip ${pair === key ? "chip-on" : ""}`}
              onClick={() => selectPair(key)}
              disabled={busy}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button className="direction" onClick={swapDirection} disabled={busy}>
          <span className="lang">{sourceLang}</span>
          <span className="arrow">→</span>
          <span className="lang lang-out">{LANG_LABEL[target]}</span>
          <span className="hint">탭하여 번역 방향 전환</span>
        </button>
      </section>

      <section className="subtitle-box" ref={subtitleRef}>
        {lines.length === 0 && !partial && (
          <p className="placeholder">
            말하기 버튼을 누르고 {sourceLang}로 말하면
            <br />
            {LANG_LABEL[target]} 번역 자막이 여기에 표시됩니다.
          </p>
        )}
        {lines.map((line, i) => (
          <p key={i} className="line">
            {line}
          </p>
        ))}
        {partial && <p className="line line-partial">{partial}</p>}
      </section>

      {errorMsg && <p className="error">{errorMsg}</p>}

      <button
        className={`mic ${live ? "mic-on" : ""}`}
        onClick={busy ? stop : start}
      >
        {live ? "정지" : connecting ? "연결 중… (탭하여 취소)" : "말하기 시작"}
      </button>

      <audio ref={audioRef} autoPlay />
    </main>
  );
}
