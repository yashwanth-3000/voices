import { Button } from "./Button";

function GitHubIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
      <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.42-4.04-1.42-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.74.08-.74 1.21.09 1.85 1.25 1.85 1.25 1.07 1.83 2.82 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.66-.3-5.46-1.33-5.46-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23A11.5 11.5 0 0 1 12 5.8c1.02.01 2.05.14 3.01.4 2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.23v3.3c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z" />
    </svg>
  );
}

export function Navbar() {
  return (
    <header className="topbar">
      <nav className="topbarInner" aria-label="Primary">
        <a className="navBrand" href="/" aria-label="Go to home">
          Voices
        </a>

        <div className="navLinks hideMobile" aria-label="Primary links">
          <a href="/styles">Styles</a>
          <a href="/wallet">Upload</a>
          <a href="/#creators">Creators</a>
          <a href="/#how">About</a>
        </div>

        <span className="navDivider hideMobile" aria-hidden="true" />
        <a
          className="navIconLink hideMobile"
          href="https://github.com/yashwanth-3000/voices"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub"
        >
          <GitHubIcon />
        </a>
        <span className="navDivider hideMobile" aria-hidden="true" />

        <Button href="/signin" variant="dark" ariaLabel="Sign in" className="navLoginButton">
          Sign in
        </Button>
      </nav>
    </header>
  );
}
