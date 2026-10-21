import "./globals.css";

export const metadata = {
  title: "PRODUCTION Overview | 生產及時看板",
  description: "Factory line status and manufacturing work order details",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
