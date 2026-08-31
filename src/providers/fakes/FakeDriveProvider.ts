import { DriveProvider } from "../DriveProvider";

export class FakeDriveProvider implements DriveProvider {
  public copyTemplateCalls: { templateId: string; targetFolderId: string }[] = [];
  public shareCalls: { fileId: string; email: string }[] = [];
  public uploadedFiles: { fileName: string; content: Buffer }[] = [];
  public deleteCalls: string[] = [];
  private nextId = 1;

  async copyTemplate(templateId: string, targetFolderId: string): Promise<string> {
    this.copyTemplateCalls.push({ templateId, targetFolderId });
    return `fake-drive-file-${this.nextId++}`;
  }

  async shareWithEmail(fileId: string, email: string): Promise<void> {
    this.shareCalls.push({ fileId, email });
  }

  async uploadFile(fileName: string, content: Buffer): Promise<string> {
    this.uploadedFiles.push({ fileName, content });
    return `https://fake-drive.example.com/files/${this.nextId++}-${fileName}`;
  }

  async deleteFile(fileId: string): Promise<void> {
    this.deleteCalls.push(fileId);
  }
}
