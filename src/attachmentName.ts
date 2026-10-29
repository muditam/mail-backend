/** Preserve supplied filenames; describe unnamed delivery report parts. */
export function attachmentName(name: string | null | undefined, type: string | undefined): string {
 if (name?.trim() && name.trim().toLowerCase() !== 'attachment') return name;
 switch (type?.split(';')[0]?.trim().toLowerCase()) {
  case 'message/delivery-status': return 'Delivery failure details.txt';
  case 'message/rfc822': return 'Returned email.eml';
  default: return name?.trim() ? name : 'attachment';
 }
}
