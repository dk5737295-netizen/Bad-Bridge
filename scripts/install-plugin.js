// Auto-install plugin into Roblox Studio on build (cross-platform)
const fs = require("fs");
const path = require("path");
const os = require("os");

const pluginSrc = path.join(__dirname, "..", "plugin", "BridgePlugin.server.luau");
if (!fs.existsSync(pluginSrc)) {
  console.log("[install-plugin] Plugin source not found, skipping");
  process.exit(0);
}

// Only works on Windows (Roblox Studio path)
if (os.platform() !== "win32") {
  console.log("[install-plugin] Non-Windows OS, skipping auto-install");
  process.exit(0);
}

const pluginDir = path.join(process.env.LOCALAPPDATA || "", "Roblox", "Plugins");
if (!fs.existsSync(pluginDir)) {
  fs.mkdirSync(pluginDir, { recursive: true });
}

// Remove old .lua version
const oldLua = path.join(pluginDir, "BAD_BridgePlugin.lua");
if (fs.existsSync(oldLua)) {
  fs.unlinkSync(oldLua);
  console.log("[install-plugin] Removed old .lua plugin");
}

// Read source, escape CDATA, wrap in .rbxmx
let source = fs.readFileSync(pluginSrc, "utf8");
source = source.replace(/\]\]>/g, "]]]]><![CDATA[>");

const rbxmx = `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">
\t<External>null</External>
\t<External>nil</External>
\t<Item class="Script" referent="RBX0000000000">
\t\t<Properties>
\t\t\t<BinaryString name="AttributesSerialize"></BinaryString>
\t\t\t<bool name="Disabled">false</bool>
\t\t\t<Content name="LinkedSource"><null></null></Content>
\t\t\t<string name="Name">BAD_BridgePlugin</string>
\t\t\t<token name="RunContext">1</token>
\t\t\t<ProtectedString name="Source"><![CDATA[${source}]]></ProtectedString>
\t\t\t<BinaryString name="Tags"></BinaryString>
\t\t</Properties>
\t</Item>
</roblox>`;

const dest = path.join(pluginDir, "BAD_BridgePlugin.rbxmx");
fs.writeFileSync(dest, rbxmx, "utf8");
console.log(`[install-plugin] Plugin installed to: ${dest}`);
