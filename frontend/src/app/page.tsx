import Link from "next/link";

export default function HomePage() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <Link
        href="/test"
        style={{
          border: "1px solid #30353a",
          borderRadius: 8,
          color: "#f2f4f5",
          padding: "12px 16px",
          textDecoration: "none"
        }}
      >
        Open test console
      </Link>
    </main>
  );
}
