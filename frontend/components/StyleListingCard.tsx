import Link from "next/link";

type StyleListingCardProps = {
  href: string;
  title: string;
  creator: string;
  price: string;
  tags: string[];
  blurb: string;
  fillText: string;
  status: string;
  tokenId: string;
  outputCount: number;
  sampleCount: number;
  hasAgentBrain: boolean;
  hasProfile: boolean;
  updatedLabel: string;
};

export function StyleListingCard({
  href,
  title,
  creator,
  price,
  tags,
  blurb,
  fillText,
  status,
  tokenId,
  outputCount,
  sampleCount,
  hasAgentBrain,
  hasProfile,
  updatedLabel,
}: StyleListingCardProps) {
  const proofCount = Number(hasAgentBrain) + Number(hasProfile);

  return (
    <Link className="styleListing" href={href} aria-label={`Open style: ${title}`}>
      <div className="styleListingTop">
        <div>
          <div className="styleListingEyebrow">
            <span>{status}</span>
            <span>Token {tokenId}</span>
          </div>
          <div className="styleListingTitle">{title}</div>
          <div className="styleListingMeta">{creator}</div>
        </div>
        <div className="styleListingPrice">{price}</div>
      </div>

      <div className="styleListingBlurb">“{blurb}”</div>
      <div className="styleListingFill">{fillText}</div>

      <div className="styleListingSignalGrid" aria-label="Style evidence">
        <div>
          <strong>{sampleCount}</strong>
          <span>samples</span>
        </div>
        <div>
          <strong>{outputCount}</strong>
          <span>outputs</span>
        </div>
        <div>
          <strong>{proofCount}/2</strong>
          <span>proofs</span>
        </div>
      </div>

      <div className="chips styleListingTags" aria-label="Style tags">
        {tags.map((t) => (
          <span className="chip" key={t}>
            {t}
          </span>
        ))}
      </div>

      <div className="styleListingFooter">
        <span>{updatedLabel}</span>
        <strong>Open style</strong>
      </div>
    </Link>
  );
}
