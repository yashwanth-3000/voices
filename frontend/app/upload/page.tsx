import { Navbar } from "../../components/Navbar";
import { Footer } from "../../components/Footer";
import { Button } from "../../components/Button";
import { PreviewBlock } from "../../components/PreviewBlock";

const sampleText =
  "Paste a few paragraphs of your writing here.\n\nTip: include 2–5 samples (newsletter, thread, blog post, doc) to capture your voice.\n\nThis is a UI prototype—nothing is uploaded in this demo.";

export default function UploadPage() {
  return (
    <div>
      <Navbar />
      <main className="siteShell">
        <section className="section">
          <div className="container">
            <div className="kicker">Upload</div>
            <h1 className="sectionTitle" style={{ marginTop: 10 }}>
              Upload your style
            </h1>
            <p className="sectionSub">
              Add writing samples and publish a licensable voice. This page is a
              pure frontend prototype—no accounts, storage, or AI processing.
            </p>

            <div className="grid twoCol" style={{ marginTop: 18 }}>
              <div className="panel">
                <div className="panelHeader">
                  <h2 className="panelTitle">Samples</h2>
                  <p className="panelSub">
                    Paste text below. In a real app, you’d upload multiple files and
                    label them by context.
                  </p>
                </div>
                <div className="panelBody">
                  <textarea
                    className="textArea"
                    defaultValue={sampleText}
                    aria-label="Writing samples"
                  />
                  <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
                    <Button variant="secondary" href="/styles">
                      Browse styles
                    </Button>
                    <Button variant="primary" href="/upload">
                      Publish (demo)
                    </Button>
                  </div>
                </div>
              </div>

              <div className="panel">
                <div className="panelHeader">
                  <h2 className="panelTitle">Preview</h2>
                  <p className="panelSub">
                    This mock “style profile” shows what explorers would see before
                    generating.
                  </p>
                </div>
                <div className="panelBody">
                  <PreviewBlock
                    title="Style profile (mock)"
                    toneLabel="Detected traits"
                    content={
                      "Tone: warm, confident, lightly humorous\nCadence: short openings → longer payoff lines\nSignatures: parenthetical asides, em dashes, strong verbs\n\nSuggested pricing:\n$0.06 / generation · $0.02 / 100 words"
                    }
                  />
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

