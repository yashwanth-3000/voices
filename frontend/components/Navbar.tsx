import { Button } from "./Button";

export function Navbar() {
  return (
    <header className="topbar">
      <div className="container">
        <div className="topbarInner">
          <a className="brand" href="#top" aria-label="Go to top">
            <span className="brandMark" aria-hidden="true" />
            <span>ContentHub</span>
          </a>

          <nav className="navLinks hideMobile" aria-label="Primary">
            <a href="#how">How it works</a>
            <a href="#featured">Featured styles</a>
            <a href="#creators">Creators</a>
            <a href="#explorers">Explore</a>
          </nav>

          <div className="row">
            <Button href="#creators" variant="secondary" ariaLabel="Explore styles">
              Explore Styles
            </Button>
            <Button href="#upload" variant="primary" ariaLabel="Upload your style">
              Upload Your Style
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}

