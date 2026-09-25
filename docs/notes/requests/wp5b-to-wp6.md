# WP5b → WP6 (tools route, payments, MockPhone)

1. **`PAY_TOOL_MODE=push` (T-D1-1, `docs/notes/wp5b.md` §1).** Route #14 for `send_esign_and_pay_link` should return
   `result: {status:"link_sent"}` plus `ui.sms`, `ui.link`, `ui.paymentId` (the contract already allows it). The
   Voice Agent controller sends that result immediately, then polls #15 every 1.5 s and uses `PaymentView.toolResult`
   (server-built) for the outcome; on success it moves the session to `close` and asks the agent to call
   `send_confirmation`.
2. **Close-stage payload without a tool response.** When the payment succeeds, the controller must send
   `session.update{system_prompt, tools}` for `close` before asking for `send_confirmation`, but `PaymentView` carries
   no stage payload. The controller takes an injected `VaStageSource(stage)` (`contracts/ext/wp5b-va.ts`). Simplest
   server-side option: add optional `stagePayload?: {stage, systemPrompt, tools, transcriptionMode?}` to the #15
   response once `status='succeeded'` (additive, in `ext/`), or let WP5/WP7 compile it client-side with WP1's
   `compilePrompt`/`toolsForStage` on the current case state. Please pick one at G2 (D3 11:00 checkpoint).
3. **MockPhone → controller.** Wire `MockPhoneProps.onState(s)` to `VoiceAgentController.setPayingState(s)`; the
   controller extends the payment deadline while the phone is in esign / signed / checkout-loading / checkout-open /
   processing / simulating and suppresses reassurance while `checkout-open` or `processing`. On the client timeout it
   emits a `payment` BatonEvent `{status:"timeout"}` so the phone can close the Polar overlay.
4. `callTool()` signature the controller needs: `VaToolCaller = (name, args, {takeoverId, callId}) => Promise<ToolResponse>`
   (the route #14 response body). An adapter is fine.
