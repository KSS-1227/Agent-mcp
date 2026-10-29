# Devpost: Additional info (for judges and organizers)

Paste ready. Written in first person singular, since this is an individual
submission. If you add a teammate, swap "I" for "we" throughout.

---

## URL to your functional demo application

```
https://d3dgn014prmcy8.cloudfront.net
```

## Testing credentials or instructions

```
There are no credentials to hand out, and nothing to install. That was a
deliberate design goal, because a service that needs a conversation before
anyone can try it does not get tried.

The fastest path is the site itself. Go to the "Try it" section and press
"Run it". That runs a real conflict against the live API and streams back the
actual SQL that executed, which detection paths fired, and the real model
ruling. Nothing on that page is mocked or replayed.

If you would rather drive it from a terminal, you need Node and nothing else:

  git clone https://github.com/usv240/interlock && cd interlock && npm install
  npm run quickstart     the whole loop: declare, collide, ruling
  npm run compare        the same collision priced with and without INTERLOCK
  npm run verify         proves a key is authenticated, isolated and metered

Each of those quietly issues itself a throwaway API key, so there is no signup
step at all. If you want your own key, the "Use it" section of the site has a
self serve form, or you can just ask for one:

  curl -X POST https://wpvk3ox2bxo2w3zhxmx54ssjf40rakuz.lambda-url.us-east-1.on.aws/v1/keys \
    -H 'content-type: application/json' -d '{"label":"judging"}'

Every key gets its own isolated tenant, with 10,000 calls and $25 a day. That
is far more headroom than judging can use, and it is there so you never hit a
rate limit and mistake it for a broken project. I run the model inference on my
own AWS account, so you are never asked for an AWS key or a model key.

One thing worth knowing: npm run compare deliberately prints a case where my
project LOSES. Below a certain amount of reasoning per task, adjudicating a
conflict costs more than just retrying it, and the tool says so in red. That is
not a bug in the demo. It is the honest shape of the result.

If you want to check everything is healthy before you start:

  npm run submission:check

It checks the site, the API, the spend ceiling, the full loop and whether the
public repo is current, and exits non zero if anything a judge can touch is
broken.
```

## URL to your open source and public code repository

```
https://github.com/usv240/interlock
```

## URL to your open source license file

```
https://github.com/usv240/interlock/blob/main/LICENSE
```

---

## Which CockroachDB tools are used?

Select **all four**: Cloud Managed MCP Server, Distributed Vector Indexing,
ccloud CLI, Agent Skills Repo.

## Which AWS Services are used?

Select **Amazon Bedrock**, **AWS Lambda**, **Amazon S3**, and **Other AWS service**.

If it asks you to name the others: Amazon EventBridge, Amazon SQS, Amazon
CloudFront, Amazon CloudWatch, AWS Budgets, AWS IAM.

Do **not** tick Amazon ECS / EKS. I designed for Fargate and never wired it up.

---

## How the components were meaningfully integrated

```
The honest test I held myself to was this: if I swapped CockroachDB out for
something else, would the project still work? The answer is no. It would stop
existing. That is the difference I was aiming for between using a database and
building on one.

Here is the problem. An AI agent reads some shared state, thinks for forty
seconds, and then acts. In those forty seconds another agent can change the
exact thing it was reasoning about. Locking the row makes everyone else wait
out a full inference. Detecting the clash afterwards means throwing away all
forty seconds of thinking. INTERLOCK does a third thing: it works out which
specific plan steps a rival commit actually invalidated, and redoes only those.
Every component below is load bearing for that one idea.

Distributed Vector Indexing.
When a commit lands I have to find every in flight plan it might have broken.
Matching on rows alone misses the interesting cases, where two plans are about
the same thing but touch different rows, so I run a nearest neighbour search
over 1024 dimension embeddings of what each agent said it was going to do. It
is a partial, tenant prefixed C-SPANN index covering only plans still in
flight, because there is no reason to ask semantic questions about plans that
already resolved. At roughly 1,700 live plans the query planner starts choosing
it, and I measured that threshold rather than guessing (npm run ai:calibrate
finds it, npm run ai:vector prints the plan and names the tenant it probed).
The part that actually matters: this search runs inside the same transaction
and against the same snapshot as the graph walk and the row check. If the
vector search lived in a separate database, it could see a different version of
the world than the transactional query did, which would reintroduce exactly the
inconsistency this whole project exists to close.

Cloud Managed MCP Server.
I did not use this as a human console. I gave it to the agent that does the
adjudicating, as a read only tool belt. Before it rules on whether a change
breaks a plan, it can ask one contextual question, like whether this resource
has been churning all morning or whether this is the first edit in an hour.
That context genuinely changes rulings. The important property is that the
channel cannot express a mutation, so an adjudicator physically cannot alter
the state it is judging, and every lookup is audit logged outside my own
logging.

ccloud CLI and the Cloud API.
There is a continuity agent that refuses to let adjudication run at all if the
cluster is not really configured to survive losing a region. That sounds
paranoid until you think about what this service is. If the referee's memory is
unavailable, every agent in the fleet becomes unsafe at the same moment. So I
made it a precondition rather than a nice to have. It also reports
gc.ttlseconds per table, which turns out to be the real ceiling on how far back
a time travel diff can reach.

Agent Skills Repo.
I used these for schema and index design. I also wrote one back, covering the
traps that cost me real time on this build, and it ships in the repo at
skills/managing-long-running-agent-transactions/. To be completely clear: it is
mine, it is in my repository, and it is not upstream. I would rather say that
plainly than let a reader assume a merge that never happened.

The core CockroachDB features, which matter as much as the four tools.
SERIALIZABLE by default means correctness is inherited from the database
instead of reimplemented by me. That is what lets me use a language model in
the decision path at all: if the model rules wrongly, you lose some wasted
work, but you can never lose an update, because the final write is still a real
serializable transaction. AS OF SYSTEM TIME is not a convenience here, it is
step three of the mechanism. I replay the exact snapshot the agent originally
read and diff it against now, which is the only way to show an agent what moved
underneath it while it was thinking. A recursive CTE walks the provenance graph
at step granularity and settles most conflicts for free, before any model is
called at all. On top of that: changefeeds driving the async pipeline, row
level TTL, follower reads on the audit feed, three different table localities,
and a three region database with SURVIVE REGION FAILURE. Eleven migrations and
fifteen tables, with live data that grows as people use the public demo,
currently around 1,900 intents and 1,600 provenance edges.

Amazon Bedrock.
Two separate jobs. Titan Text Embeddings V2 produces the 1024 dimension vectors
that make semantic detection possible in the first place. Claude does the
actual adjudication, judging whether a specific change breaks a specific plan
and naming which steps died. It runs on two caller selectable tiers named by
role rather than by model id, so your code keeps working when a model id
changes. The cheaper tier is the default, because the provenance graph has
already narrowed the question down before a model ever sees it. Every call's
token usage is written to a spend ledger that enforces a real ceiling.

AWS Lambda.
The public API is a Lambda function URL, no API Gateway in front of it. It
declares intents, accepts commits, runs the three detection paths, does the
time travel diff, calls Bedrock when the graph could not settle things, and
enforces the spend ceiling before any inference happens. A second Lambda runs
the async worker with capped concurrency, specifically so a burst of background
adjudication cannot starve the API a user is waiting on.

Amazon EventBridge and SQS.
A CockroachDB changefeed on the resource table drives async adjudication
through EventBridge into SQS, with a dead letter queue and partial batch
failure handling. SQS delivers at least once, which is normally something you
have to defend against. Here it is free, because exactly once is enforced
structurally by a UNIQUE index on the commit and intent pair, so a redelivery
fails loudly as a no op instead of quietly recording a second verdict for one
conflict.

Amazon S3 and CloudFront.
The demo site is a static export on a private S3 origin, readable only by
CloudFront through Origin Access Control. No public bucket policy.

Amazon CloudWatch, AWS Budgets and AWS IAM.
CloudWatch logs caught two real bugs during the build: a cold start syntax
failure and a cross region IAM denial. AWS Budgets holds a $20 monthly cap on
the account, alerting at 50%, 80% and 100%. That is alert only by design,
because Budgets can only send email: the enforcement that actually refuses to
spend lives in the API handler, ahead of every Bedrock call.
The runtime IAM role is scoped to nine specific model and inference
profile ARNs rather than bedrock:*, with explicit denies on deleting evidence or
altering model access. That cross region denial is worth passing on to other
entrants, and it is why the list is nine rather than two:
Claude's us. inference profiles dispatch across regions, so a policy allowing
only us-east-1 model ARNs will fail at runtime with a denial naming us-east-2,
because that is where the profile routed the call.

What I chose not to claim.
An earlier draft of my submission listed ECS Fargate. I designed for it and
never wired it up, so I took it out. "Meaningfully integrated, not just
initialized" is a pass or fail rule, and claiming the services I genuinely run
on is worth more than claiming a longer list I half use.
```

---

## What date did you start this project?

```
08-13-26
```

## Please explain any pre-existing code or work incorporated into the Project

```
None. Nothing here predates the submission period.

There is no earlier codebase underneath this one, and I did not incorporate any
pre existing code or work. The first commit is 13 August 2026 and the entire
history is public in the repository, so this is checkable rather than something
you have to take my word for.

I used standard development tooling throughout, including an AI coding
assistant, which the rules explicitly permit. I am mentioning it directly
because this project makes a point of publishing what it actually did rather
than only the parts that flatter it, and it would be strange to make that claim
and then be vague here.

Two things I want to state precisely, because both could otherwise look like
incorporated work.

First, CockroachDB Agent Skills. I consumed these for schema and index design,
which is what the hackathon intends them for. I also wrote one in return, and
it ships in my repo at skills/managing-long-running-agent-transactions/. It is
my own work, written during this project. It is not upstream, and I make no
claim that it was merged anywhere.

Second, prior art. The baseline comparison figures in my benchmark are
CoAgent's published numbers (arXiv:2606.15376). They are labelled "published"
everywhere they appear and kept visually distinct from figures my own harness
produced, so nobody can mistake one for the other. No code from that paper, or
from any other paper I cite, is used anywhere in this project. The core insight,
that a language model can judge whether a conflicting write actually
invalidates its plan, comes from that paper and I credit it openly. The
implementation is entirely mine, and as far as I can tell it is the first open
source one.

Dependencies are ordinary open source packages under permissive licences: pg,
the AWS SDK, LangChain core, Next.js, React and Tailwind. They are all visible
in package.json and web/package.json.
```

---

## Feedback on the CockroachDB AI tools or features

```
Genuinely useful, and a few things cost me time that I would rather save
someone else.

The managed MCP server accepting a service account API key as a bearer token,
not just OAuth, is what made a headless auditor possible for me. The console
only documents the OAuth flow, and I nearly concluded that what I wanted was
not supported. That is worth documenting more prominently, because it unlocks a
whole category of use where there is no human sitting at a browser.

Follower reads fail through MCP with "inconsistent AS OF SYSTEM TIME
timestamp", even though the identical query works fine on a direct connection.
I worked around it by applying follower reads on my own connection instead, but
it took a while to work out that the transport was the problem rather than my
query.

CREATE CHANGEFEED defaulting to an initial scan is absolutely the right default
for replication, and an expensive one for event driven work. My first run
happily re-adjudicated the whole of history: 22 batches, 25,000 tokens. Nothing
broke, because my unique index turned every replay into a no op, but it was
real money spent on nothing. A louder warning, or a hint in the docs at the
point where you would write an event driven changefeed, would have caught it.

Vector index selection is invisible until suddenly it is not, and this was by
far the most expensive class of bug in my build. Mine was unusable for two
completely unrelated reasons: first it was built for L2 while every query asked
in cosine, and then once that was fixed it would only be selected for
unfiltered queries that nothing in my system actually runs. Both failures
looked identical from the outside, which is to say a query plan that quietly
says "scan" and no error anywhere. A SHOW VECTOR INDEX diagnostic, or an
EXPLAIN hint that says why a vector index was rejected, would have saved me
days. This is my strongest piece of feedback.

Small one to finish: ADD REGION IF NOT EXISTS is idempotent but SET PRIMARY
REGION is not, which makes writing a genuinely re-runnable migration slightly
awkward.
```

---

## Which AI tools have you leveraged while working on this project?

```
Two different things, and I think the distinction matters, so I will separate
them.

While building it, I used Claude (Anthropic) through Claude Code as a coding
assistant. The rules permit AI coding assistants explicitly, and I am
disclosing it plainly rather than leaving it to be inferred.

Inside the product itself, AI models are not a development tool but a component
at runtime. Amazon Bedrock provides Titan Text Embeddings V2, which turns each
agent's declared plan into a 1024 dimension vector so I can detect conflicts
between plans that mean the same thing without touching the same rows. Bedrock
also provides Claude, which performs the actual adjudication: given a change
and a plan, it judges whether the plan is still valid and names which specific
steps died.

Worth adding, because it shaped the architecture: I treat the model as
fallible on purpose. A recursive SQL query settles most conflicts before any
model is consulted, and the final write is always a real serializable
transaction. So if the model gets a ruling wrong, the cost is wasted work, not
a lost update. I did not want correctness resting on an LLM being right.
```

---

## Level of learning derived from the project (dropdown)

Pick honestly. If it helps you choose, here is what the project actually
taught, in your own words if you want them:

```
A lot, and mostly not what I expected. I assumed the hard part would be getting
a language model to judge conflicts well. It was not. The hard part was that
twelve of my bugs were silent: the code ran, returned plausible results, and
was wrong. A spend ceiling that read a ledger nothing ever wrote to. A vector
index serving a query nobody runs. A CORS header that passed every test I had
and failed only in real browsers. I learned more about verifying my own
assumptions than about prompting.
```

## Did you gain AI value you can use in your career? (dropdown)

```
Yes. The specific transferable thing is knowing where a language model belongs
in a system and where it does not. Here it belongs at the judgment step, after
a cheap deterministic filter has narrowed the question, and behind a
transaction that stays correct even if the model is wrong. That shape, cheap
filter first, model second, database guaranteeing correctness last, is
something I would reach for again on any system where an LLM touches shared
state.
```

---

## YOU: fields only you can fill

| Field | Note |
|---|---|
| **Submitter type** | Individual, unless someone else worked on this with you. |
| **Country of residence** | Yours to state. Appears publicly in the gallery. |
| **Organization name** | Leave blank if individual. |
| **Architectural diagram** (optional) | Upload one. The README renders a mermaid architecture diagram on GitHub. Open the repo, screenshot that diagram, save as PNG. It satisfies an optional rules item and gives judges the whole system in one picture. |
| **Three eligibility checkboxes** | Read them and tick. They are legal declarations about employment, jurisdiction, and being of age. Only you can make them. |
