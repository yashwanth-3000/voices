import { Navbar } from "../../components/Navbar";
import { Footer } from "../../components/Footer";
import { StyleListingCard } from "../../components/StyleListingCard";

type Listing = {
  title: string;
  creator: string;
  price: string;
  tags: string[];
  blurb: string;
};

const listings: Listing[] = [
  {
    title: "Witty & conversational",
    creator: "Romi Chen · @romi",
    price: "$0.02 / gen",
    tags: ["playful", "casual", "millennial"],
    blurb:
      "Okay, so here’s the thing: clarity is cute, but personality is what people remember.",
  },
  {
    title: "Formal & analytical",
    creator: "Jules Park · @jules.memos",
    price: "$0.09 / gen",
    tags: ["memos", "evidence", "structured"],
    blurb:
      "This proposal increases expected value under conservative assumptions while preserving downside protections.",
  },
  {
    title: "Minimal & poetic",
    creator: "Noor S. · @noor.poetry",
    price: "$0.06 / gen",
    tags: ["brand", "cadence", "minimal"],
    blurb:
      "A quiet sentence can hold a loud idea—if you let the air do some work.",
  },
  {
    title: "Viral social voice",
    creator: "Saoirse Doyle · @saoirse",
    price: "$0.08 / gen",
    tags: ["hooks", "short-form", "punchy"],
    blurb:
      "We shipped it. It’s faster. It’s cleaner. And yes—your future self will thank you.",
  },
  {
    title: "Contrarian finance",
    creator: "Devansh Patel · @dev.p",
    price: "$0.06 / gen",
    tags: ["analytical", "contrarian", "concise"],
    blurb:
      "The consensus is comfortable. That’s precisely why it’s expensive.",
  },
  {
    title: "Observational essay",
    creator: "Lin Halverson · @lin.h",
    price: "$0.06 / gen",
    tags: ["observational", "tender", "essay"],
    blurb:
      "The small detail isn’t small—it’s the hinge the whole moment swings on.",
  },
  {
    title: "Lyrical literary",
    creator: "Maren Vasquez · @maren.v",
    price: "$0.06 / gen",
    tags: ["lyrical", "quiet", "literary"],
    blurb:
      "The paragraph listened first; only then did it decide what it could afford to say.",
  },
  {
    title: "Crisp product copy",
    creator: "Amina Rao · @amina.ink",
    price: "$0.07 / gen",
    tags: ["product-led", "clear", "confident"],
    blurb:
      "Less clicking. Fewer tabs. More done. The feature disappears—because the friction does.",
  },
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
              {listings.map((l) => (
                <StyleListingCard
                  key={`${l.title}-${l.creator}`}
                  title={l.title}
                  creator={l.creator}
                  price={l.price}
                  tags={l.tags}
                  blurb={l.blurb}
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

