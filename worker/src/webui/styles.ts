export const GLOBAL_CSS = `*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:0;background:#f4f4f5;color:#18181b;line-height:1.5}
.container{display:flex;height:100vh}
.sidebar{width:240px;background:#fafafa;border-right:1px solid #e4e4e7;padding:16px;overflow-y:auto}
.sidebar h2{font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#71717a;margin:0 0 12px}
.sidebar ul{list-style:none;margin:0;padding:0}
.sidebar li a{display:block;padding:8px 12px;color:#27272a;text-decoration:none;border-radius:6px;font-size:14px}
.sidebar li a:hover{background:#f4f4f5}
.sidebar li a.current{background:#e4e4e7;font-weight:600}
.sidebar .count{float:right;color:#71717a;font-size:12px}
.main{flex:1;overflow-y:auto;padding:20px}
.memories{max-width:900px}
.topic-group{margin-bottom:24px}
.topic-group h3{font-size:16px;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid #e4e4e7;color:#3f3f46;text-transform:capitalize}
.memory-card{background:#fff;border:1px solid #e4e4e7;border-radius:8px;padding:12px;margin-bottom:8px}
.memory-content{white-space:pre-wrap;word-break:break-word;margin-bottom:8px}
.memory-meta{font-size:12px;color:#71717a;margin-bottom:8px}
.memory-meta .badge{display:inline-block;padding:2px 6px;border-radius:4px;background:#f4f4f5;margin-right:6px}
.memory-meta .badge.curated{background:#dcfce7;color:#166534}
.memory-actions{display:flex;gap:8px;align-items:center}
.memory-actions a{font-size:12px;color:#2563eb;text-decoration:none}
.memory-actions button{font-size:12px;background:none;border:none;color:#dc2626;cursor:pointer;padding:2px 6px}
.edit-form textarea{width:100%;min-height:80px;padding:8px;border:1px solid #d4d4d8;border-radius:6px;font:inherit;resize:vertical;margin-bottom:8px}
.edit-form select{padding:6px;border:1px solid #d4d4d8;border-radius:6px;font:inherit;margin-bottom:8px}
.edit-form .row{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.btn{padding:6px 12px;border-radius:6px;border:1px solid transparent;font-size:13px;cursor:pointer;text-decoration:none;display:inline-block}
.btn-primary{background:#2563eb;color:#fff;border-color:#2563eb}
.btn-secondary{background:#fff;color:#27272a;border-color:#d4d4d8}
.btn-danger{background:#dc2626;color:#fff;border-color:#dc2626}
.confirm-box{background:#fff;border:1px solid #e4e4e7;border-radius:8px;padding:16px;margin-bottom:16px;max-width:600px}
.confirm-box blockquote{margin:8px 0;padding:8px;border-left:3px solid #d4d4d8;background:#f4f4f5;color:#3f3f46}
.flash{padding:10px 12px;border-radius:6px;margin-bottom:16px;font-size:13px}
.flash.success{background:#dcfce7;color:#166534;border:1px solid #bbf7d0}
.flash.error{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
.header-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.header-bar h1{font-size:20px;margin:0}
.session-log{margin-top:32px;max-width:900px}
.session-log h3{font-size:16px;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid #e4e4e7}
.session-row{display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #f4f4f5;font-size:12px;align-items:center}
.session-row .id{color:#71717a;min-width:180px;word-break:break-all}
.session-row .date{color:#71717a;min-width:140px}
.session-row .status{font-weight:600}
.session-row .status.unconsolidated{color:#b45309}
.session-row .status.consolidated{color:#166534}
.session-row .status.error{color:#991b1b}
.session-row .tokens{color:#71717a;min-width:60px}
.session-row .err{color:#991b1b;flex:1;word-break:break-word}
.empty{color:#71717a;font-size:13px;padding:16px 0}
.logout-form{display:inline}
.archived-toggle{margin-bottom:12px}
.archived-toggle a{font-size:13px;color:#2563eb;text-decoration:none}
.consolidate-form{margin-bottom:12px}
.status-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:14px}
.status-item{background:#fff;border:1px solid #e4e4e7;border-radius:8px;padding:10px}
.status-item .label{display:block;font-size:11px;text-transform:uppercase;color:#71717a}
.status-item .value{font-size:18px;font-weight:600;color:#18181b}
.search-form{display:flex;gap:8px;margin-bottom:12px}
.search-form input{flex:1;padding:8px;border:1px solid #d4d4d8;border-radius:6px;font:inherit}
.no-projects{color:#71717a;padding:20px}`;
