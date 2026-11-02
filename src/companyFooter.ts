// Company-owned email footer. Keep the HTML and plain-text versions in sync.
export const companyFooterHtml = "<!-- muditam-company-footer-v1 -->\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"600\" style=\"width:600px;max-width:100%;border-collapse:collapse;background:#ffffff;color:#242424;font-family:Arial,Helvetica,sans-serif;\">\n<tr><td colspan=\"3\" height=\"16\" style=\"height:16px;font-size:0;\">&nbsp;</td></tr>\n<tr>\n<td width=\"210\" valign=\"middle\" style=\"width:210px;padding:12px 20px 12px 12px;text-align:center;\">\n<a href=\"https://www.muditam.com/\" style=\"text-decoration:none;\"><img src=\"https://www.muditam.com/cdn/shop/files/Muditam_Logo-01-01.png?v=1725434339&amp;width=600\" width=\"180\" height=\"36\" alt=\"Muditam\" border=\"0\" style=\"display:block;width:180px;height:36px;margin:0 auto;\"></a>\n</td>\n<td width=\"1\" style=\"width:1px;background:#dedbd7;font-size:0;\">&nbsp;</td>\n<td valign=\"middle\" style=\"padding:6px 12px 6px 24px;\">\n<div style=\"font-size:17px;line-height:23px;font-weight:bold;color:#242424;\">Muditam Ayurveda Private Limited</div>\n<div style=\"font-size:13px;line-height:21px;margin-top:12px;\"><a href=\"mailto:hello@muditam.com\" style=\"color:#444444;text-decoration:none;\">hello@muditam.com</a><br><a href=\"tel:+917011683883\" style=\"color:#444444;text-decoration:none;\">Customer Support: +91 7011683883</a></div>\n<div style=\"font-size:12px;line-height:19px;margin-top:10px;color:#626262;\">D42, Dr. Ambedkar Colony, Chattarpur<br>Enclave, Opposite Vishal Megamart,<br>100 Feet Road Phase 1, New Delhi, 110074</div>\n<div style=\"font-size:13px;line-height:21px;margin-top:7px;font-weight:bold;\"><a href=\"https://www.muditam.com/\" style=\"color:#242424;text-decoration:none;\">www.muditam.com</a></div>\n</td></tr>\n<tr><td colspan=\"3\" height=\"20\" style=\"height:20px;font-size:0;\">&nbsp;</td></tr>\n<tr><td colspan=\"3\" height=\"2\" style=\"height:2px;background:#cb5c2d;font-size:0;line-height:2px;\">&nbsp;</td></tr>\n</table>";
export const companyFooterText = "Muditam Ayurveda Private Limited\nhello@muditam.com\nCustomer Support: +91 7011683883\n\nD42, Dr. Ambedkar Colony, Chattarpur\nEnclave, Opposite Vishal Megamart,\n100 Feet Road Phase 1, New Delhi, 110074\n\nhttps://www.muditam.com/";

const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));

export function outgoingBody(bodyText:string){
 // A failed submission may leave a prepared draft. Do not stack the footer on retry.
 const suffix='\n\n-- \n'+companyFooterText;
 let content=bodyText.replace(/\r\n/g,'\n');
 while(content.endsWith(suffix))content=content.slice(0,-suffix.length);
 return {
  textBody:[{partId:'body',type:'text/plain'}],
  htmlBody:[{partId:'html',type:'text/html'}],
  bodyValues:{
   body:{value:content+suffix},
   html:{value:'<!doctype html><html><body><div style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif;">'+escapeHtml(content).replace(/\n/g,'<br>')+'</div><br>'+companyFooterHtml+'</body></html>'},
  },
 };
}
