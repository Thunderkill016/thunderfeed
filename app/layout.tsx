import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ThunderFeed — Bản tin nhận định",
  description:
    "Tổng hợp và phân tích tin tức đa nguồn: mỗi sự kiện có nhận định, phổ truyền thông và đối chiếu giật tít.",
};

export const viewport: Viewport = {
  themeColor: "#f7f4ec",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
