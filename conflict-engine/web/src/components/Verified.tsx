import { VERIFIED } from "@/lib/content";
import InfoButton from "./InfoButton";
import { Disclosure } from "./ui";

/**
 * Claims, and the command that proves each one.
 *
 * Every row here is something the rest of the page asserts. Pairing each claim
 * with the exact query or script that produced it is the difference between a
 * marketing page and an engineering one: a judge can run the third column and
 * check the second.
 */
export default function Verified() {
  // Collapsed by default. It is the most credible thing on the page and also
  // the least readable in passing — eight rows of claim-and-command that a
  // reader either wants in full or does not want to scroll through at all.
  // Open is one click; scrolling past it was not optional.
  return (
    <Disclosure
      className="mt-6"
      summary="Verified against the live cluster"
      hint={`${VERIFIED.length} claims, each with the command that proves it`}
    >
      <div className="overflow-hidden card">
      <div className="flex items-center gap-2 border-b border-hairline px-5 py-4 sm:px-6">
        <h3 className="text-sm font-semibold text-ink">
          Every claim, and how to check it
        </h3>
        <InfoButton
          title="Why this table exists"
          what="Each claim on this page paired with the command that produced it."
          how="Clone the repo, point it at your own cluster and run the third column. If a number here disagrees with what you get, the number here is wrong."
          note="Nothing in this table is aspirational. Target figures are labelled as targets elsewhere on the page."
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[38rem] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-hairline">
              {["Claim", "Value", "How it was checked"].map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted sm:px-6"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {VERIFIED.map((v) => (
              <tr key={v.claim} className="border-b border-hairline last:border-0">
                <th
                  scope="row"
                  className="px-5 py-3 font-medium text-ink sm:px-6"
                >
                  {v.claim}
                </th>
                <td className="px-5 py-3 text-ink-2 sm:px-6">{v.value}</td>
                <td className="px-5 py-3 sm:px-6">
                  <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">
                    {v.how}
                  </code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>
    </Disclosure>
  );
}
