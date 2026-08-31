import { NotificationEvent } from "@prisma/client";
import { EmailProvider } from "../EmailProvider";

export class FakeEmailProvider implements EmailProvider {
  public sent: { to: string; eventType: NotificationEvent; relatedId: string }[] = [];
  private shouldFailNext = false;

  // Makes the next send() call throw, then behaves normally again.
  failNextSend(): void {
    this.shouldFailNext = true;
  }

  async send(to: string, eventType: NotificationEvent, relatedId: string): Promise<void> {
    if (this.shouldFailNext) {
      this.shouldFailNext = false;
      throw new Error("Simulated email send failure");
    }
    this.sent.push({ to, eventType, relatedId });
  }
}
