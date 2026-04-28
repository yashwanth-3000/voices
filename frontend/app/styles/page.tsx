import { Navbar } from "../../components/Navbar";
import { Footer } from "../../components/Footer";
import { StyleListingCard } from "../../components/StyleListingCard";
import { styles } from "../../lib/styles";

const fillLines = [
  "Includes tone traits, cadence notes, and sample outputs for fast comparison.",
  "Optimized for consistent voice across posts, memos, landing pages, and threads.",
  "Preview hooks, structure, and phrasing patterns before you generate.",
];

export default function StylesPage() {
  return (
    <div>
      <Navbar />
      <main className="siteShell">
        <section className="section">
          <div className="container">
            <div className="kicker">Styles</div>
            <h1 className="sectionTitle" style={{ marginTop: 10 }}>
              Explore writing styles
            </h1>
            <p className="sectionSub">
              A gallery of creator-uploaded voices. Browse by vibe, preview the tone,
              then pick a style for your next post, memo, landing page, or thread.
            </p>

            <div className="styleGallery" style={{ marginTop: 18 }}>
              {styles.map((s, i) => (
                <StyleListingCard
                  key={s.slug}
                  href={`/styles/${s.slug}`}
                  title={s.title}
                  creator={`${s.creatorName} · @${s.creatorHandle}`}
                  price={s.price}
                  tags={s.tags}
                  blurb={s.blurb}
                  fillText={fillLines[i % fillLines.length]}
                />
              ))}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

