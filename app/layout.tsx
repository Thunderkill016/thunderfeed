import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.TF_SITE_URL ?? "https://thunderfeed.vercel.app",
  ),
  title: "ThunderFeed — Bản tin nhận định",
  description:
    "Tổng hợp và phân tích tin tức đa nguồn: mỗi sự kiện có nhận định, phổ truyền thông và đối chiếu giật tít.",
  openGraph: {
    type: "website",
    locale: "vi_VN",
    siteName: "ThunderFeed",
    title: "ThunderFeed — Bản tin nhận định",
    description:
      "Theo dõi sự kiện, phát hiện khi dữ kiện thực sự thay đổi — với bằng chứng đối chiếu đa nguồn.",
  },
  twitter: { card: "summary" },
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
