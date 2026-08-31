/* DeliveryService contract (spec §18).

   interface DeliveryService {
     deliver(prompt: StructuredPrompt): Promise<DeliveryResult>
     copy(text: string): Promise<void>
   }

   DeliveryResult = { ok: boolean, channel: string, prepared?: boolean }

   This phase: ClipboardDelivery. Note: real clipboard writes require a
   user gesture, so deliver() only "prepares" (called during sending);
   copy() performs the actual write (called from the Copy button). */

export function assertDeliveryService(service) {
  ["deliver", "copy"].forEach((m) => {
    if (typeof service[m] !== "function") {
      throw new Error("DeliveryService missing method: " + m);
    }
  });
  return service;
}
