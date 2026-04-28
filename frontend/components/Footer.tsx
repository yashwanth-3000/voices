export function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="divider" />
        <div className="footerTop">
          <div>
            <div className="brand">
              <span className="brandMark" aria-hidden="true" />
              <span>ContentHub</span>
            </div>
            <p className="fine">
              A frontend-only prototype for a marketplace where creators monetize
              their writing style and teams generate content with authentic voices.
              No accounts, payments, or AI calls are wired up in this demo.
            </p>
          </div>
          <div className="miniLinks" aria-label="Footer links">
            <a href="#how">How it works</a>
            <a href="#featured">Featured</a>
            <a href="#creators">Creators</a>
            <a href="#explorers">Explore</a>
            <a href="#upload">Upload</a>
          </div>
        </div>
        <p className="fine">© {new Date().getFullYear()} ContentHub</p>
      </div>
    </footer>
  );
}

