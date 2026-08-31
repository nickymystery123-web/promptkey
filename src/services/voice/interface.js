/* VoiceService contract (spec §17).

   interface VoiceService {
     start(): Promise<void>
     stop(): Promise<void>    // STOP/DONE — finalize recognition (may still emit final result + end)
     abort(): Promise<void>   // CANCEL — abandon immediately; any trailing events are ignored by flows
     onTranscript(callback: (text: string, isFinal: boolean) => void): void
     onEnd(callback: () => void): void
     onError(callback: (code: string) => void): void
     isAvailable(): boolean
   }

   stop vs abort: stop lets the provider deliver the final transcript (user finished
   speaking); abort discards the session (user cancelled — nothing may reach the AI).

   Continuous listening (Phase 3C-2A): a browser-level onend caused by a pause is
   NOT a "user finished" signal — the provider auto-restarts internally and keeps
   emitting transcripts. The flow's onEnd fires only when the user explicitly
   stops (stop()) or cancels (abort()), or on a real terminal error.

   UI never touches the browser Speech API directly — always via an adapter. */

export function assertVoiceService(service) {
  ["start", "stop", "abort", "onTranscript", "onEnd", "onError", "isAvailable"].forEach((m) => {
    if (typeof service[m] !== "function") {
      throw new Error("VoiceService missing method: " + m);
    }
  });
  return service;
}
