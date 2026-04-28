import Link from "next/link";

type StyleListingCardProps = {
  href: string;
  title: string;
  creator: string;
  price: string;
  tags: string[];
  blurb: string;
  fillText: string;
};

export function StyleListingCard({
  href,
  title,
  creator,
  price,
  tags,
  blurb,
  fillText,
}: StyleListingCardProps) {
  return (
    <Link className="styleListing" href={href} aria-label={`Open style: ${title}`}>
      <div className="styleListingTop">
        <div>
          <div className="styleListingTitle">{title}</div>
          <div className="styleListingMeta">{creator}</div>
        </div>
        <div className="styleListingPrice">{price}</div>
      </div>

      <div className="styleListingBlurb">“{blurb}”</div>
      <div className="styleListingFill">{fillText}</div>

      <div className="chips styleListingTags" aria-label="Style tags">
        {tags.map((t) => (
          <span className="chip" key={t}>
            {t}
          </span>
        ))}
      </div>
    </Link>
  );
}

