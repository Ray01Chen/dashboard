import "./globals.css";

export const metadata = {
  title: "MES 工單生產監控 | Manufacturing Dashboard",
  description: "MES manufacturing work order dashboard with live API integration",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
