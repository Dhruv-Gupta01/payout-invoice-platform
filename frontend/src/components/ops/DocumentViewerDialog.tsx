import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// Uploaded documents are stored on Google Drive; `fileUrl` is Drive's
// webViewLink ("https://drive.google.com/file/d/<id>/view?..."). Drive
// serves an embeddable preview at the same path with /preview instead of
// /view — swap it in for the iframe, but keep the original link around too
// since an iframe preview can refuse to render if the viewer isn't signed
// into a Google account with access to the file (private KYC folder) —
// same access requirement a new-tab open would have hit anyway.
function toDrivePreviewUrl(url: string): string {
  const match = url.match(/\/file\/d\/([^/]+)/);
  return match ? `https://drive.google.com/file/d/${match[1]}/preview` : url;
}

export function DocumentViewerDialog({
  url,
  title,
  onOpenChange,
}: {
  url: string | null;
  title?: string | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={url !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] w-[95vw] max-w-4xl flex-col gap-3 sm:rounded-lg">
        <DialogHeader>
          <DialogTitle className="pr-8 text-[16px]">{title ?? "Document"}</DialogTitle>
        </DialogHeader>
        {url && (
          <>
            <iframe
              src={toDrivePreviewUrl(url)}
              title={title ?? "Document preview"}
              className="min-h-0 flex-1 rounded-md border border-border bg-muted"
            />
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="self-start text-[12px] text-muted-foreground underline-offset-4 hover:underline"
            >
              Not loading? Open in a new tab instead
            </a>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
