import { Button } from "./Button";

export function Navbar() {
  return (
    <header className="topbar">
      <div className="container">
        <div className="topbarInner">
          <a className="brand" href="/" aria-label="Go to home">
            <span className="brandMark" aria-hidden="true" />
            <span>Voices</span>
          </a>

          <nav className="navLinks hideMobile" aria-label="Primary">
            <a href="/styles">Styles</a>
            <a href="/upload">Upload</a>
            <a href="/#creators">Creators</a>
            <a href="/#how">How it works</a>
          </nav>

          <Button href="/signin" variant="dark" ariaLabel="Sign in" className="navLoginButton">
            Sign in
          </Button>
        </div>
      </div>
    </header>
  );
}

