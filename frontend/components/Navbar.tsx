import { Button } from "./Button";

export function Navbar() {
  return (
    <header className="topbar">
      <div className="container">
        <div className="topbarInner">
          <a className="brand" href="/" aria-label="Go to home">
            <span className="brandMark" aria-hidden="true" />
            <span>ContentHub</span>
          </a>

          <nav className="navLinks hideMobile" aria-label="Primary">
            <a href="/styles">
              <span>Styles</span>
              <span className="navIcon" aria-hidden="true">
                ✎
              </span>
            </a>
            <a href="/upload">
              <span>Upload</span>
              <span className="navIcon" aria-hidden="true">
                +
              </span>
            </a>
            <a href="/#creators">
              <span>Creators</span>
              <span className="navIcon" aria-hidden="true">
                ⌘
              </span>
            </a>
            <a href="/#how">How it works</a>
          </nav>

          <Button href="/signin" variant="dark" ariaLabel="Sign in">
            Sign in
          </Button>
        </div>
      </div>
    </header>
  );
}

