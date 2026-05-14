import "./globals.css";

export const metadata = {
  title: "실시간 통역기",
  description: "OpenAI Realtime API 기반 모바일 실시간 통역기",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
