import Link from "next/link";

interface PactAgentLogoProps {
  readonly showDescriptor?: boolean;
}

export function PactAgentLogo({ showDescriptor = true }: PactAgentLogoProps) {
  return (
    <Link className="brand" href="/" aria-label="PactAgent home">
      <svg
        className="brandMark"
        viewBox="0 0 64 64"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="2" y="2" width="60" height="60" rx="10" fill="currentColor" />
        <path
          className="brandGlyph"
          fillRule="evenodd"
          d="M14 12h23c8.84 0 15 5.84 15 14s-6.16 14-15 14H26v12H14V12Zm12 10v8h10.5c2.2 0 3.5-1.55 3.5-4s-1.3-4-3.5-4H26Z"
        />
        <path className="brandRibbon" d="m27 32 8 8 15-15v11L35 51 19 35l8-3Z" />
        <path className="brandJoint" d="m35 40 5-5v10l-5 6-5-5 5-6Z" />
      </svg>
      <span className="brandWordmark"><strong>PACT</strong>AGENT</span>
      {showDescriptor ? <span className="phase">APPLICATION ON OPEN PROTOCOLS</span> : null}
    </Link>
  );
}
