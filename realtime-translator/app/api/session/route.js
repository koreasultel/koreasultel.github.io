export const runtime = "nodejs";

const ALLOWED_LANGUAGES = new Set(["ko", "zh", "ja", "fr", "de", "pt", "en"]);

export async function POST(request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "서버에 OPENAI_API_KEY가 설정되지 않았습니다." },
      { status: 500 }
    );
  }

  let language;
  try {
    ({ language } = await request.json());
  } catch {
    return Response.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  if (!ALLOWED_LANGUAGES.has(language)) {
    return Response.json(
      { error: "지원하지 않는 출력 언어입니다." },
      { status: 400 }
    );
  }

  const res = await fetch(
    "https://api.openai.com/v1/realtime/translations/client_secrets",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          model: "gpt-realtime-translate",
          audio: {
            input: {
              transcription: { model: "gpt-realtime-whisper" },
              noise_reduction: { type: "near_field" },
            },
            output: { language },
          },
        },
      }),
    }
  );

  if (!res.ok) {
    const detail = await res.text();
    return Response.json(
      { error: "OpenAI 세션 생성에 실패했습니다.", detail },
      { status: 502 }
    );
  }

  const data = await res.json();
  const clientSecret =
    data?.client_secret?.value ?? data?.client_secret ?? data?.value;

  if (!clientSecret) {
    return Response.json(
      { error: "OpenAI 응답에서 토큰을 찾을 수 없습니다." },
      { status: 502 }
    );
  }

  return Response.json({ client_secret: clientSecret });
}
