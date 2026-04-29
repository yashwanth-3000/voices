"use client";

import Link from "next/link";
import "./test-page.css";

const testRoutes = [
  {
    href: "/test/creator",
    eyebrow: "Style creator",
    title: "Create + mint",
    description: "Paste samples, sign the attestation, build the AgentBrain manifest, and mint a style iNFT."
  },
  {
    href: "/test/marketplace",
    eyebrow: "Marketplace",
    title: "Browse styles",
    description: "Inspect real on-chain styles with profiles, AgentBrain roots, sample excerpts, and recent outputs."
  },
  {
    href: "/test/chat",
    eyebrow: "Use style",
    title: "Chat + generate",
    description: "Pick an existing creator style, generate content, settle credits, and inspect the proof trail."
  },
  {
    href: "/test/full",
    eyebrow: "Full lab",
    title: "Everything together",
    description: "Open the complete cockpit when you want to debug the whole creator, marketplace, and generation flow at once."
  }
];

export function TestHubClient() {
  return (
    <main className="test-shell">
      <section className="test-header test-hub-header">
        <div>
          <p className="eyebrow">Voices test pages</p>
          <h1>Pick one flow to test</h1>
          <p className="header-copy">
            The live demo is split into smaller surfaces so you can verify each backend path without the full cockpit crowding the screen.
          </p>
        </div>
      </section>

      <section className="test-hub-grid" aria-label="Test page launcher">
        {testRoutes.map((route) => (
          <Link className="test-hub-card" href={route.href} key={route.href}>
            <span>{route.eyebrow}</span>
            <strong>{route.title}</strong>
            <p>{route.description}</p>
          </Link>
        ))}
      </section>
    </main>
  );
}
