/**
 * src/content/about.ts - the "how it works" copy that used to be `/about` (now folded into `/`, P§12.2), reused by
 * the README and the architecture slide. Same wording rules as `landing.ts`.
 *
 * The privacy section follows `docs/notes/requests/wp8-to-wp13.md` (T-D1-0b): recordings of ended sessions are
 * deleted, and we never claim DELETE ends a live session.
 */
import type { AboutContent } from "@/core/contracts/ext/wp13-content";

/** The README and deck line on the LLM Gateway (P§11). */
export const LLM_GATEWAY_LINE =
  "AssemblyAI's LLM Gateway requires a paid account; extraction and drafting use OpenAI directly behind one client, " +
  "a base-URL swap away.";

export const ABOUT: AboutContent = {
  sections: [
    {
      id: "how",
      title: "How a relay runs",
      paragraphs: [
        [
          { strong: "Shadow. " },
          "While the rep talks, AssemblyAI Universal-3.5 Pro Realtime runs one streaming session per channel, so the " +
            "rep and the customer are never mixed up. Each final turn goes to an extractor that proposes facts; " +
            "deterministic code decides each fact's status (verified, pending, missing) and links it to the turn and " +
            "audio clip it came from. The language model proposes, the code decides.",
        ],
        [
          { strong: "Pass the baton. " },
          "When the rep presses the button, Changeover waits for the current turn to end, freezes the case, and " +
            "compiles the AI half: a greeting of at most 40 words that recites the customer's own facts, a prompt, " +
            "and only the tools for the current stage. An AssemblyAI Voice Agent opens with that config and takes " +
            "over. Stages move confirm → disclose → pay → close, and each stage change sends the next prompt and " +
            "tools mid-session.",
        ],
        [
          { strong: "Prove it. " },
          "When the call ends, the Voice Agent's own recording goes to AssemblyAI async transcription (multichannel). " +
            "The QA card is computed from that transcript: was the disclosure read verbatim (text similarity of at " +
            "least 0.90 plus the critical words), and did the AI re-ask anything already on the case?",
        ],
      ],
    },
    {
      id: "both-apis",
      title: "Why both AssemblyAI APIs",
      paragraphs: [
        [
          "The Voice Agent API alone cannot hear the first half of the call, because the human is talking, not the " +
            "agent. Realtime STT alone cannot finish the call, because someone has to speak, call tools and handle " +
            "interruptions. Changeover needs ",
          { strong: "Universal-3.5 Pro Realtime" },
          " to build the case while the human talks and the ",
          { strong: "Voice Agent API" },
          " to finish from that case; async transcription then checks the result against the audio.",
        ],
      ],
    },
    {
      id: "studio",
      title: "Changeover Studio",
      paragraphs: [
        [
          "A relay is a versioned JSON blueprint: the fields the case tracks, what the AI listens for, the handoff " +
            "line, the playbook stages, and the connectors (payment link, e-sign, SMS, lookup table, HTTP action). " +
            "Baton · insurance add-a-driver is one of these blueprints. In the Studio you can open it, run the " +
            "gallery relays on simulated calls, try a one-click edit and hear the AI change, and publish a relay as " +
            "a stored AssemblyAI agent.",
        ],
      ],
    },
    {
      id: "trust",
      title: "Trust by design",
      paragraphs: [
        [
          { strong: "Money fails closed. " },
          "A payment counts only when the payment provider says so (webhook or server check), never because the AI " +
            "or the browser said it was paid.",
        ],
        [
          { strong: "Disclosures are fetched, not remembered. " },
          "The AI gets the disclosure text from a tool at the right stage and cannot skip the stage.",
        ],
        [
          { strong: "Relays built by strangers are fenced. " },
          "A safety block the author cannot remove, a safe pattern grammar, a brand denylist, OpenAI moderation " +
            "before Test and Publish, a \"User-made relay, fictional\" label, and no mic on share pages.",
        ],
        [{ strong: "Language models. " }, LLM_GATEWAY_LINE],
      ],
    },
    {
      id: "privacy",
      title: "Privacy",
      paragraphs: [
        [
          "The customers, policies and cases in the gallery are fictional role-play data. The AI half of a run is recorded by AssemblyAI (stored " +
            "in eu-west-1) so it can be verified; we delete those recordings, and the verification transcripts, " +
            "after 7 days. We store transcripts and metrics, not your raw audio. Please don't share real personal " +
            "information.",
        ],
      ],
    },
  ],
};
