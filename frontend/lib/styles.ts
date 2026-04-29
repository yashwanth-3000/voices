export type StyleModel = {
  id: string;
  title: string;
  creatorName: string;
  creatorHandle: string;
  price: string;
  tags: string[];
  blurb: string;
  about: string;
  bestFor: string[];
  traits: { label: string; value: string }[];
  samples: { label: string; text: string }[];
};

export const styles: StyleModel[] = [
  {
    id: "witty-conversational",
    title: "Witty & conversational",
    creatorName: "Romi Chen",
    creatorHandle: "romi",
    price: "$0.02 / gen",
    tags: ["playful", "casual", "millennial"],
    blurb:
      "Okay, so here’s the thing: clarity is cute, but personality is what people remember.",
    about:
      "A friendly voice that reads like a smart friend who edits for rhythm. Great hooks, gentle persuasion, and just enough humor to keep things human.",
    bestFor: ["Founder posts", "Product updates", "Landing page copy", "Customer emails"],
    traits: [
      { label: "Tone", value: "Warm, clever, lightly mischievous" },
      { label: "Cadence", value: "Short open → longer payoff" },
      { label: "Signature", value: "Asides, em dashes, crisp verbs" },
    ],
    samples: [
      {
        label: "Launch post",
        text:
          "We rebuilt onboarding in 14 days.\n\nNot because we love redesigns (we don’t).\nBecause we love when the product makes sense.\n\nThe new flow is faster, calmer, and quietly gets you to “done.”",
      },
      {
        label: "Newsletter intro",
        text:
          "This week: one small change that saves you an hour.\n\nIt’s not flashy. It’s just… considerate. Like a feature that remembered you’re busy.",
      },
    ],
  },
  {
    id: "formal-analytical",
    title: "Formal & analytical",
    creatorName: "Jules Park",
    creatorHandle: "jules.memos",
    price: "$0.09 / gen",
    tags: ["memos", "evidence", "structured"],
    blurb:
      "This proposal increases expected value under conservative assumptions while preserving downside protections.",
    about:
      "A structured memo style with clear premises, precise language, and calm conclusions. Reads like a decision-ready brief.",
    bestFor: ["Executive memos", "Specs", "Research summaries", "Policy docs"],
    traits: [
      { label: "Tone", value: "Neutral, precise, decision-oriented" },
      { label: "Structure", value: "Summary → assumptions → recommendation" },
      { label: "Signature", value: "Definitions, constraints, trade-offs" },
    ],
    samples: [
      {
        label: "Executive summary",
        text:
          "Summary:\nThe recommended rollout reduces operational risk while maintaining delivery velocity.\n\nRecommendation:\nProceed with a 30-day staged rollout and weekly retention review.",
      },
      {
        label: "Spec excerpt",
        text:
          "Constraints:\n- Must preserve backward compatibility\n- Must not increase p95 latency\n\nTrade-off:\nWe accept minor complexity to achieve stronger correctness guarantees.",
      },
    ],
  },
  {
    id: "minimal-poetic",
    title: "Minimal & poetic",
    creatorName: "Noor S.",
    creatorHandle: "noor.poetry",
    price: "$0.06 / gen",
    tags: ["brand", "cadence", "minimal"],
    blurb: "A quiet sentence can hold a loud idea—if you let the air do some work.",
    about:
      "Clean, spacious copy with a soft rhythm. Fewer words, more feeling. Great for brand pages and product positioning.",
    bestFor: ["Brand pages", "Campaigns", "Headlines", "Taglines"],
    traits: [
      { label: "Tone", value: "Quiet confidence" },
      { label: "Cadence", value: "Short lines, deliberate pauses" },
      { label: "Signature", value: "Imagery over explanation" },
    ],
    samples: [
      {
        label: "Hero copy",
        text: "Write like you.\nEverywhere.\n\nA voice you can share.\nA craft that can pay.",
      },
      {
        label: "Campaign line",
        text: "Less noise.\nMore signal.\n\nKeep the sentence honest.",
      },
    ],
  },
  {
    id: "viral-social",
    title: "Viral social voice",
    creatorName: "Saoirse Doyle",
    creatorHandle: "saoirse",
    price: "$0.08 / gen",
    tags: ["hooks", "short-form", "punchy"],
    blurb: "We shipped it. It’s faster. It’s cleaner. And yes—your future self will thank you.",
    about:
      "High hook density, rapid pattern breaks, and punchy payoffs. Built for short-form posts that keep attention.",
    bestFor: ["Threads", "Tweets", "Short announcements", "Creator scripts"],
    traits: [
      { label: "Tone", value: "Bold, fast, confident" },
      { label: "Cadence", value: "Hook → bullets → punchline" },
      { label: "Signature", value: "Pattern breaks, contrast, crisp CTA" },
    ],
    samples: [
      {
        label: "Thread opener",
        text:
          "We fixed the slowest part of the workflow.\n\nNot with a big rewrite.\nWith 3 small decisions.\n\nHere’s what changed:",
      },
      {
        label: "Announcement",
        text:
          "New feature: it deletes busywork.\n\nIf you’ve ever thought “why is this 6 clicks?”—this is for you.",
      },
    ],
  },
  {
    id: "contrarian-finance",
    title: "Contrarian finance",
    creatorName: "Devansh Patel",
    creatorHandle: "dev.p",
    price: "$0.06 / gen",
    tags: ["analytical", "contrarian", "concise"],
    blurb: "The consensus is comfortable. That’s precisely why it’s expensive.",
    about:
      "Concise arguments with a skeptical edge. Great for market commentary, investing memos, and sharp positioning.",
    bestFor: ["Market notes", "Investor updates", "Opinion essays", "Positioning docs"],
    traits: [
      { label: "Tone", value: "Skeptical, sharp, calm" },
      { label: "Structure", value: "Claim → why it’s wrong → what to watch" },
      { label: "Signature", value: "Contrast, constraints, clear bets" },
    ],
    samples: [
      {
        label: "Market note",
        text:
          "The market is pricing certainty.\n\nBut certainty is what disappears first.\nWatch the inputs, not the headlines.",
      },
      {
        label: "Positioning",
        text:
          "If everyone is saying the same thing, it’s already in the price.\n\nDifferentiation starts where consensus ends.",
      },
    ],
  },
  {
    id: "observational-essay",
    title: "Observational essay",
    creatorName: "Lin Halverson",
    creatorHandle: "lin.h",
    price: "$0.06 / gen",
    tags: ["observational", "tender", "essay"],
    blurb: "The small detail isn’t small—it’s the hinge the whole moment swings on.",
    about:
      "A reflective, detail-forward voice with soft precision. Great for essays, brand storytelling, and thoughtful posts.",
    bestFor: ["Essays", "Brand stories", "Creator blogs", "Culture notes"],
    traits: [
      { label: "Tone", value: "Tender, observant" },
      { label: "Cadence", value: "Measured, gently unfolding" },
      { label: "Signature", value: "Concrete details → meaning" },
    ],
    samples: [
      {
        label: "Essay opening",
        text:
          "There’s a moment in the afternoon when the light changes its mind.\n\nThat’s when I remember: attention is a choice.",
      },
      {
        label: "Brand story",
        text:
          "We didn’t set out to build a system.\nWe set out to fix one small frustration.\n\nThen another.\nThen the habit formed.",
      },
    ],
  },
  {
    id: "lyrical-literary",
    title: "Lyrical literary",
    creatorName: "Maren Vasquez",
    creatorHandle: "maren.v",
    price: "$0.06 / gen",
    tags: ["lyrical", "quiet", "literary"],
    blurb: "The paragraph listened first; only then did it decide what it could afford to say.",
    about:
      "Quiet, lyrical prose with deliberate imagery. Great for high-end brand tone and editorial writing.",
    bestFor: ["Editorial", "Luxury brand", "Long-form", "Narrative intros"],
    traits: [
      { label: "Tone", value: "Quiet, lyrical" },
      { label: "Cadence", value: "Longer sentences, careful rhythm" },
      { label: "Signature", value: "Imagery, restraint, subtext" },
    ],
    samples: [
      {
        label: "Opening paragraph",
        text:
          "The kettle clicked off.\nOutside, the city kept doing its slow, deliberate thing.\n\nInside, the sentence waited—patient as steam.",
      },
      {
        label: "Brand line",
        text: "Make it simple.\nNot smaller.\n\nLet the work feel inevitable.",
      },
    ],
  },
  {
    id: "crisp-product-copy",
    title: "Crisp product copy",
    creatorName: "Amina Rao",
    creatorHandle: "amina.ink",
    price: "$0.07 / gen",
    tags: ["product-led", "clear", "confident"],
    blurb: "Less clicking. Fewer tabs. More done. The feature disappears—because the friction does.",
    about:
      "Direct, confident product language with strong verbs and practical clarity. Built for UX copy and launch messaging.",
    bestFor: ["Product pages", "Onboarding", "Tooltips", "Release notes"],
    traits: [
      { label: "Tone", value: "Confident, clear" },
      { label: "Cadence", value: "Short, scannable lines" },
      { label: "Signature", value: "Benefit-first, action verbs" },
    ],
    samples: [
      {
        label: "Release note",
        text:
          "New: one-click summaries.\n\nStop scanning five tabs.\nGet the answer.\nKeep moving.",
      },
      {
        label: "Landing page",
        text:
          "Your work, organized.\n\nFind what matters in seconds—and make the next decision faster.",
      },
    ],
  },
];

export function getStyle(id: string): StyleModel | undefined {
  return styles.find((s) => s.id === id);
}

