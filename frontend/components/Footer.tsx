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
              A frontend-only prototype for a marketplace where creators monetize
              their writing style and teams generate content with authentic voices.
              No accounts, payments, or AI calls are wired up in this demo.
            </p>
          </div>
          <div className="miniLinks" aria-label="Footer links">
            <Link href="/#how">How it works</Link>
            <Link href="/#featured">Featured</Link>
            <Link href="/#creators">Creators</Link>
            <Link href="/#explorers">Explore</Link>
            <Link href="/upload">Upload</Link>
          </div>
        </div>
        <p className="fine">© {new Date().getFullYear()} Voices</p>
      </div>
    </footer>
  );
}
