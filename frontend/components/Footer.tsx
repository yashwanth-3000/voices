import Link from "next/link";

export function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="divider" />
        <div className="footerTop">
          <div>
            <div className="brand">
              <span className="brandMark" aria-hidden="true" />
              <span>Voices</span>
            </div>
            <p className="fine">
              Creator writing styles become ownable AI voice agents with
              AgentBrain manifests, live generation logs, proof trails, and
              on-chain royalty settlement.
            </p>
          </div>
          <div className="miniLinks" aria-label="Footer links">
            <Link href="/#how">How it works</Link>
            <Link href="/#featured">Featured</Link>
            <Link href="/#explorers">Explore</Link>
            <Link href="/upload">Upload</Link>
          </div>
        </div>
        <p className="fine">© {new Date().getFullYear()} Voices</p>
      </div>
    </footer>
  );
}
