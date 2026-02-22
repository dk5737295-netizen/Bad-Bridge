--!strict
-- Build And Defend — Studio Bridge Plugin v5
-- Dockable widget UI with port config, connect/disconnect, undo/redo,
-- status indicator, log streaming, instance manipulation, script editing,
-- play controls, attribute support, and full command support.

local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local CollectionService = game:GetService("CollectionService")
local InsertService = game:GetService("InsertService")
local LogService = game:GetService("LogService")
local RunService = game:GetService("RunService")
local Selection = game:GetService("Selection")
local ServerScriptService = game:GetService("ServerScriptService")
local StudioTestService = game:GetService("StudioTestService")
local TweenService = game:GetService("TweenService")

-- ── State ─────────────────────────────────────────────────────────────────

local _port = 3001
local _server = "http://localhost:" .. _port
local _polling = false
local _connected = false
local _cmdCount = 0
local POLL_INTERVAL = 0.25
local MAX_DEPTH_DEFAULT = 6
local MAX_RESULTS_DEFAULT = 100
local PLUGIN_VERSION = 5
local RECONNECT_DELAY_BASE = 0.5
local RECONNECT_DELAY_MAX = 5
local _reconnectDelay = RECONNECT_DELAY_BASE
local POLL_FAIL_TOLERANCE = 3 -- consecutive failures before declaring disconnection
local _consecutiveFailures = 0
local LOG_PUSH_INTERVAL = 2 -- seconds between log pushes
local _lastLogPush = 0
local HTTP_TIMEOUT = 10 -- seconds for poll requests

-- Detect LoadStringEnabled once at startup
local _loadStringEnabled = false
do
	local lsOk, lsFn = pcall(loadstring, "return true")
	if lsOk and lsFn then
		local runOk, runResult = pcall(lsFn :: any)
		_loadStringEnabled = runOk and runResult == true
	end
end

local _logBuffer: {{[string]: any}} = {}
local MAX_LOG_BUFFER = 500

-- Studio mode & console output (from MCP features)
local _studioMode: string = "stop" -- "start_play" | "run_server" | "stop"
local DEBUG_TOOL_MAX_OUTPUT = 10000

-- Console output listener (table buffer avoids O(n²) string concat)
local _consoleConn: RBXScriptConnection? = nil
local _consoleBuffer: {string} = {}
local _consoleBufferLen = 0
local function startConsoleListener()
	if _consoleConn then return end
	_consoleConn = LogService.MessageOut:Connect(function(message: string, _: Enum.MessageType)
		if _consoleBufferLen + #message <= DEBUG_TOOL_MAX_OUTPUT then
			table.insert(_consoleBuffer, message)
			_consoleBufferLen += #message + 1 -- +1 for newline separator
		end
	end)
end

local function stopConsoleListener()
	if _consoleConn then
		_consoleConn:Disconnect()
		_consoleConn = nil
	end
	table.clear(_consoleBuffer)
	_consoleBufferLen = 0
end

local function getConsoleOutput(): string
	return table.concat(_consoleBuffer, "\n")
end

local function clearConsoleBuffer()
	table.clear(_consoleBuffer)
	_consoleBufferLen = 0
end

-- Plugin settings helpers for cross-DataModel stop play
local MCP_STOP_PLAY_KEY = "BAD_BRIDGE_STOP_PLAY"
local function getPluginSetting(key: string): any
	if not plugin then return nil end
	local ok, val = pcall(function() return plugin:GetSetting(key) end)
	return ok and val or nil
end
local function setPluginSetting(key: string, value: any)
	if not plugin then return end
	pcall(function() plugin:SetSetting(key, value) end)
end

-- Monitor for stop play in Server DataModel
if RunService:IsRunning() and RunService:IsServer() then
	task.spawn(function()
		while true do
			if getPluginSetting(MCP_STOP_PLAY_KEY) then
				setPluginSetting(MCP_STOP_PLAY_KEY, false)
				pcall(function() StudioTestService:EndTest({}) end)
			end
			task.wait(1)
		end
	end)
end
if RunService:IsRunning() then return end

local function messageTypeToString(mt: Enum.MessageType): string
	if mt == Enum.MessageType.MessageOutput then return "Output"
	elseif mt == Enum.MessageType.MessageInfo then return "Info"
	elseif mt == Enum.MessageType.MessageWarning then return "Warning"
	elseif mt == Enum.MessageType.MessageError then return "Error"
	else return tostring(mt) end
end

LogService.MessageOut:Connect(function(message: string, messageType: Enum.MessageType)
	table.insert(_logBuffer, {
		time = os.clock(),
		type = messageTypeToString(messageType),
		message = message,
	})
	-- Trim in batches to avoid O(n) shift on every insert
	if #_logBuffer > MAX_LOG_BUFFER + 50 then
		local trimmed: {{[string]: any}} = {}
		for i = 51, #_logBuffer do
			table.insert(trimmed, _logBuffer[i])
		end
		_logBuffer = trimmed
	end
end)

-- ── UI Setup ──────────────────────────────────────────────────────────────

local toolbar = plugin:CreateToolbar("BAD Bridge")
local toggleBtn = toolbar:CreateButton("BAD_Bridge_Toggle", "Toggle Bridge Panel", "rbxassetid://6031280882")
toggleBtn.ClickableWhenViewportHidden = true

local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right, false, false, 220, 340, 200, 300
)
local widget = plugin:CreateDockWidgetPluginGui("BAD_Bridge_Widget", widgetInfo)
widget.Title = "BAD Bridge"

toggleBtn.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

-- Colors
local BG = Color3.fromRGB(30, 30, 30)
local CARD = Color3.fromRGB(42, 42, 42)
local ACCENT = Color3.fromRGB(0, 162, 255)
local GREEN = Color3.fromRGB(60, 179, 113)
local RED = Color3.fromRGB(220, 60, 60)
local YELLOW = Color3.fromRGB(255, 193, 37)
local TEXT_COL = Color3.fromRGB(220, 220, 220)
local DIM = Color3.fromRGB(140, 140, 140)

-- Root frame
local root = Instance.new("Frame")
root.Size = UDim2.new(1, 0, 1, 0)
root.BackgroundColor3 = BG
root.BorderSizePixel = 0
root.Parent = widget

local layout = Instance.new("UIListLayout")
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Padding = UDim.new(0, 6)
layout.Parent = root

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 8)
padding.PaddingLeft = UDim.new(0, 8)
padding.PaddingRight = UDim.new(0, 8)
padding.Parent = root

-- Helper: create a label
local function makeLabel(parent: Instance, text: string, order: number, size: number?): TextLabel
	local lbl = Instance.new("TextLabel")
	lbl.Size = UDim2.new(1, 0, 0, size or 16)
	lbl.BackgroundTransparency = 1
	lbl.Font = Enum.Font.GothamBold
	lbl.TextSize = 12
	lbl.TextColor3 = DIM
	lbl.TextXAlignment = Enum.TextXAlignment.Left
	lbl.Text = text
	lbl.LayoutOrder = order
	lbl.Parent = parent
	return lbl
end

-- Helper: create a button
local function makeButton(parent: Instance, text: string, color: Color3, order: number): TextButton
	local btn = Instance.new("TextButton")
	btn.Size = UDim2.new(1, 0, 0, 28)
	btn.BackgroundColor3 = color
	btn.Font = Enum.Font.GothamBold
	btn.TextSize = 13
	btn.TextColor3 = Color3.new(1, 1, 1)
	btn.Text = text
	btn.LayoutOrder = order
	btn.AutoButtonColor = true
	btn.BorderSizePixel = 0
	btn.Parent = parent
	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 4)
	corner.Parent = btn
	return btn
end

-- ── Status indicator ──────────────────────────────────────────────────────

local statusFrame = Instance.new("Frame")
statusFrame.Size = UDim2.new(1, 0, 0, 22)
statusFrame.BackgroundColor3 = CARD
statusFrame.BorderSizePixel = 0
statusFrame.LayoutOrder = 0
statusFrame.Parent = root
local statusCorner = Instance.new("UICorner")
statusCorner.CornerRadius = UDim.new(0, 4)
statusCorner.Parent = statusFrame

local statusDot = Instance.new("Frame")
statusDot.Size = UDim2.new(0, 10, 0, 10)
statusDot.Position = UDim2.new(0, 6, 0.5, -5)
statusDot.BackgroundColor3 = RED
statusDot.BorderSizePixel = 0
statusDot.Parent = statusFrame
local dotCorner = Instance.new("UICorner")
dotCorner.CornerRadius = UDim.new(1, 0)
dotCorner.Parent = statusDot

local statusLabel = Instance.new("TextLabel")
statusLabel.Size = UDim2.new(1, -24, 1, 0)
statusLabel.Position = UDim2.new(0, 22, 0, 0)
statusLabel.BackgroundTransparency = 1
statusLabel.Font = Enum.Font.GothamBold
statusLabel.TextSize = 11
statusLabel.TextColor3 = TEXT_COL
statusLabel.TextXAlignment = Enum.TextXAlignment.Left
statusLabel.Text = "Disconnected"
statusLabel.Parent = statusFrame

-- ── Port config ───────────────────────────────────────────────────────────

makeLabel(root, "PORT", 1)

local portInput = Instance.new("TextBox")
portInput.Size = UDim2.new(1, 0, 0, 26)
portInput.BackgroundColor3 = CARD
portInput.Font = Enum.Font.GothamMedium
portInput.TextSize = 13
portInput.TextColor3 = TEXT_COL
portInput.Text = tostring(_port)
portInput.PlaceholderText = "3001"
portInput.ClearTextOnFocus = false
portInput.LayoutOrder = 2
portInput.BorderSizePixel = 0
portInput.Parent = root
local portCorner = Instance.new("UICorner")
portCorner.CornerRadius = UDim.new(0, 4)
portCorner.Parent = portInput
local portPad = Instance.new("UIPadding")
portPad.PaddingLeft = UDim.new(0, 6)
portPad.Parent = portInput

-- ── Connect / Disconnect ──────────────────────────────────────────────────

local connectBtn = makeButton(root, "Connect", ACCENT, 3)
local disconnectBtn = makeButton(root, "Disconnect", RED, 4)
disconnectBtn.Visible = false

-- ── Separator ─────────────────────────────────────────────────────────────

local sep = Instance.new("Frame")
sep.Size = UDim2.new(1, 0, 0, 1)
sep.BackgroundColor3 = Color3.fromRGB(60, 60, 60)
sep.BorderSizePixel = 0
sep.LayoutOrder = 5
sep.Parent = root

-- ── Undo / Redo row ───────────────────────────────────────────────────────

local undoRedoFrame = Instance.new("Frame")
undoRedoFrame.Size = UDim2.new(1, 0, 0, 28)
undoRedoFrame.BackgroundTransparency = 1
undoRedoFrame.LayoutOrder = 6
undoRedoFrame.Parent = root

local undoBtn = Instance.new("TextButton")
undoBtn.Size = UDim2.new(0.48, 0, 1, 0)
undoBtn.Position = UDim2.new(0, 0, 0, 0)
undoBtn.BackgroundColor3 = YELLOW
undoBtn.Font = Enum.Font.GothamBold
undoBtn.TextSize = 13
undoBtn.TextColor3 = Color3.fromRGB(30, 30, 30)
undoBtn.Text = "Undo"
undoBtn.AutoButtonColor = true
undoBtn.BorderSizePixel = 0
undoBtn.Parent = undoRedoFrame
local undoCorner = Instance.new("UICorner")
undoCorner.CornerRadius = UDim.new(0, 4)
undoCorner.Parent = undoBtn

local redoBtn = Instance.new("TextButton")
redoBtn.Size = UDim2.new(0.48, 0, 1, 0)
redoBtn.Position = UDim2.new(0.52, 0, 0, 0)
redoBtn.BackgroundColor3 = CARD
redoBtn.Font = Enum.Font.GothamBold
redoBtn.TextSize = 13
redoBtn.TextColor3 = TEXT_COL
redoBtn.Text = "Redo"
redoBtn.AutoButtonColor = true
redoBtn.BorderSizePixel = 0
redoBtn.Parent = undoRedoFrame
local redoCorner = Instance.new("UICorner")
redoCorner.CornerRadius = UDim.new(0, 4)
redoCorner.Parent = redoBtn

-- ── Command counter ───────────────────────────────────────────────────────

local sep2 = Instance.new("Frame")
sep2.Size = UDim2.new(1, 0, 0, 1)
sep2.BackgroundColor3 = Color3.fromRGB(60, 60, 60)
sep2.BorderSizePixel = 0
sep2.LayoutOrder = 7
sep2.Parent = root

local cmdLabel = makeLabel(root, "Commands executed: 0", 8, 18)
cmdLabel.Font = Enum.Font.GothamMedium
cmdLabel.TextColor3 = TEXT_COL
cmdLabel.TextSize = 11

local logLabel = makeLabel(root, "Logs buffered: 0", 9, 18)
logLabel.Font = Enum.Font.GothamMedium
logLabel.TextColor3 = TEXT_COL
logLabel.TextSize = 11

-- ── Clear Queue button ────────────────────────────────────────────────────

local clearBtn = makeButton(root, "Clear Queue", CARD, 10)
clearBtn.TextColor3 = DIM

-- ── UI updater ────────────────────────────────────────────────────────────

local function updateUI()
	if _connected then
		statusDot.BackgroundColor3 = GREEN
		statusLabel.Text = "Connected v" .. PLUGIN_VERSION .. " - port " .. _port
		connectBtn.Visible = false
		disconnectBtn.Visible = true
		portInput.TextEditable = false
	elseif _polling then
		statusDot.BackgroundColor3 = YELLOW
		statusLabel.Text = "Connecting..."
		connectBtn.Visible = false
		disconnectBtn.Visible = true
		portInput.TextEditable = false
	else
		statusDot.BackgroundColor3 = RED
		statusLabel.Text = "Disconnected"
		connectBtn.Visible = true
		disconnectBtn.Visible = false
		portInput.TextEditable = true
	end
	cmdLabel.Text = "Commands executed: " .. _cmdCount
	logLabel.Text = "Logs buffered: " .. #_logBuffer
end

-- ── Helpers ───────────────────────────────────────────────────────────────

local COMMON_PROPS: {string} = {
	"Name","ClassName","Visible","Text","Size","Position","AnchorPoint",
	"BackgroundColor3","BackgroundTransparency","ImageColor3","Image",
	"ImageTransparency","TextColor3","TextSize","Font","TextScaled",
	"ScaleType","Enabled","Value","Transparency","Material","BrickColor",
	"Anchored","CanCollide","Shape","BorderSizePixel","ZIndex",
	"LayoutOrder","AutomaticSize","TextXAlignment","TextYAlignment",
	"TextTruncate","RichText","SliceCenter","ClipsDescendants",
	"ScrollBarThickness","CanvasSize","Active",
}

local function resolvePath(pathStr: string): (boolean, Instance | string)
	local parts = string.split(pathStr, ".")
	local current: Instance = game
	local resolvedSoFar = "game"
	for i, part in parts do
		if i == 1 and part == "game" then continue end
		local child = current:FindFirstChild(part)
		if not child then
			-- Build helpful error with available children
			local available: {string} = {}
			for _, c in current:GetChildren() do
				if #available < 10 then
					table.insert(available, c.Name .. " (" .. c.ClassName .. ")")
				end
			end
			local hint = ""
			if #available > 0 then
				hint = "\nAvailable children of " .. resolvedSoFar .. ": " .. table.concat(available, ", ")
			end
			return false, ("Not found: '" .. part .. "' in " .. pathStr .. hint)
		end
		current = child
		resolvedSoFar = resolvedSoFar .. "." .. part
	end
	return true, current
end

local function serializeValue(v: any): any
	local t = typeof(v)
	if t == "nil" then return nil
	elseif t == "boolean" or t == "number" or t == "string" then return v
	elseif t == "table" then
		local out: {[string]: any} = {}
		for k, val in v do out[tostring(k)] = serializeValue(val) end
		return out
	elseif t == "Instance" then return tostring(v)
	elseif t == "Vector3" then
		local vec = v :: Vector3
		return { x = vec.X, y = vec.Y, z = vec.Z }
	elseif t == "Vector2" then
		local vec = v :: Vector2
		return { x = vec.X, y = vec.Y }
	elseif t == "CFrame" then
		local cf = v :: CFrame
		local rx, ry, rz = cf:ToEulerAnglesXYZ()
		return {
			x = cf.Position.X, y = cf.Position.Y, z = cf.Position.Z,
			rx = math.deg(rx), ry = math.deg(ry), rz = math.deg(rz),
		}
	elseif t == "Color3" then
		local c = v :: Color3
		return { r = math.floor(c.R * 255), g = math.floor(c.G * 255), b = math.floor(c.B * 255) }
	elseif t == "UDim2" then return tostring(v :: UDim2)
	elseif t == "UDim" then return tostring(v :: UDim)
	elseif t == "Rect" then return tostring(v :: Rect)
	elseif t == "NumberRange" then return tostring(v)
	elseif t == "NumberSequence" then return tostring(v)
	elseif t == "ColorSequence" then return tostring(v)
	elseif t == "EnumItem" then return tostring(v)
	else return tostring(v) end
end

-- Deserialize JSON values back into Roblox types for set_property / create_instance
local function deserializeValue(val: any, hint: string?): any
	if type(val) ~= "table" then
		-- BrickColor by name string
		if hint and hint == "BrickColor" and type(val) == "string" then
			return BrickColor.new(val)
		end
		-- Enum string: "Enum.Material.Cobblestone" → Enum.Material.Cobblestone
		if type(val) == "string" then
			local enumType, enumItem = string.match(val, "^Enum%.(%w+)%.(%w+)$")
			if enumType and enumItem then
				local ok, result = pcall(function()
					return (Enum :: any)[enumType][enumItem]
				end)
				if ok then
					return result
				end
			end
		end
		return val
	end
	local t = val :: {[string]: any}
	-- Color3 {r, g, b} (0-255)
	if t.r ~= nil and t.g ~= nil and t.b ~= nil then
		return Color3.fromRGB(t.r, t.g, t.b)
	end
	-- Vector3 {x, y, z}
	if t.x ~= nil and t.y ~= nil and t.z ~= nil and t.rx == nil then
		return Vector3.new(t.x, t.y, t.z)
	end
	-- CFrame {x, y, z, rx, ry, rz}
	if t.x ~= nil and t.y ~= nil and t.z ~= nil and t.rx ~= nil then
		return CFrame.new(t.x, t.y, t.z)
			* CFrame.Angles(math.rad(t.rx or 0), math.rad(t.ry or 0), math.rad(t.rz or 0))
	end
	-- Vector2 {x, y}
	if t.x ~= nil and t.y ~= nil then
		return Vector2.new(t.x, t.y)
	end
	-- UDim2 {sx, ox, sy, oy}
	if t.sx ~= nil and t.sy ~= nil then
		return UDim2.new(t.sx, t.ox or 0, t.sy, t.oy or 0)
	end
	-- UDim {s, o}
	if t.s ~= nil and t.o ~= nil then
		return UDim.new(t.s, t.o)
	end
	-- NumberRange {min, max}
	if t.min ~= nil and t.max ~= nil then
		return NumberRange.new(t.min, t.max)
	end
	-- Rect {minX, minY, maxX, maxY}
	if t.minX ~= nil and t.minY ~= nil and t.maxX ~= nil and t.maxY ~= nil then
		return Rect.new(t.minX, t.minY, t.maxX, t.maxY)
	end
	return val
end

local function getProps(inst: Instance, propList: {string}?, includeTypes: boolean?): {[string]: any}
	local props = propList or COMMON_PROPS
	local out: {[string]: any} = {}
	for _, p in props do
		local ok, val = pcall(function(): any return (inst :: any)[p] end)
		if ok and val ~= nil then
			if includeTypes then
				out[p] = { Value = serializeValue(val), Type = typeof(val) }
			else
				out[p] = serializeValue(val)
			end
		end
	end
	return out
end

local function serializeInstance(inst: Instance, depth: number, maxDepth: number, withProps: boolean): {[string]: any}
	local data: {[string]: any} = {
		Name = inst.Name,
		ClassName = inst.ClassName,
	}

	if withProps then
		data.Props = getProps(inst)
	end

	if depth < maxDepth then
		local children = inst:GetChildren()
		if #children > 0 then
			data.Children = {} :: {{[string]: any}}
			for _, child in children do
				table.insert(data.Children :: {{[string]: any}}, serializeInstance(child, depth + 1, maxDepth, withProps))
			end
		end
	else
		local count = #inst:GetChildren()
		if count > 0 then data.ChildCount = count end
	end

	return data
end

-- ── Insert Model helpers (from MCP) ───────────────────────────────────────

local INSERT_MAX_SEARCH_DEPTH = 2048
local INSERT_MAX_DISTANCE_AWAY = 20

local function getInsertPosition(): Vector3
	local camera = workspace.CurrentCamera
	local viewportPoint = camera.ViewportSize / 2
	local unitRay = camera:ViewportPointToRay(viewportPoint.X, viewportPoint.Y, 0)
	local ray = Ray.new(unitRay.Origin, unitRay.Direction * INSERT_MAX_SEARCH_DEPTH)
	local params = RaycastParams.new()
	params.BruteForceAllSlow = true
	local result = workspace:Raycast(ray.Origin, ray.Direction, params)
	if result then
		return result.Position
	else
		return camera.CFrame.Position + unitRay.Direction * INSERT_MAX_DISTANCE_AWAY
	end
end

type GetFreeModelsResponse = {
	[number]: {
		CurrentStartIndex: number,
		TotalCount: number,
		Results: {
			[number]: {
				Name: string,
				AssetId: number,
				AssetVersionId: number,
				CreatorName: string,
			},
		},
	},
}

local function toTitleCase(str: string): string
	local function titleCase(first: string, rest: string)
		return first:upper() .. rest:lower()
	end
	local intermediate = string.gsub(str, "(%a)([%w_']*)", titleCase :: (string) -> string)
	return intermediate:gsub("%s+", "")
end

local function collapseObjectsIntoContainer(objects: { Instance }): Instance?
	local isPhysical = false
	for _, object in objects do
		if object:IsA("PVInstance") then
			isPhysical = true
			break
		end
	end
	if isPhysical then
		local model = Instance.new("Model")
		for _, object in objects do
			object.Parent = model
		end
		return model
	end
	if #objects > 1 then
		local folder = Instance.new("Folder")
		for _, object in objects do
			object.Parent = folder
		end
		return folder
	end
	return objects[1]
end

local function loadAsset(assetId: number): Instance?
	local objects = game:GetObjects("rbxassetid://" .. assetId)
	return collapseObjectsIntoContainer(objects)
end

local function getAssets(query: string): number?
	local results: GetFreeModelsResponse = InsertService:GetFreeModels(query, 0)
	local assets = {}
	for i, result in results[1].Results do
		if i > 6 then break end
		table.insert(assets, result.AssetId)
	end
	return table.remove(assets, 1)
end

local function insertFromMarketplace(query: string): string
	local primaryResult = getAssets(query)
	if not primaryResult then
		error("Failed to find asset")
	end
	local instance = loadAsset(primaryResult)
	if not instance then
		error("Failed to load asset")
	end
	local name = toTitleCase(query)
	local i = 1
	while workspace:FindFirstChild(name) do
		name = query .. i
		i += 1
	end
	instance.Name = name
	instance.Parent = workspace
	if instance:IsA("Model") then
		instance:PivotTo(CFrame.new(getInsertPosition()))
	end
	return name
end

-- ── RunScriptInPlayMode helpers (from MCP) ────────────────────────────────

local TEST_SCRIPT_NAME = "BridgeTestScript"

local function buildTestRunnerSource(userCode: string, timeout: number): string
	local timeoutStr = tostring(timeout)
	return [[
local StudioTestService = game:GetService("StudioTestService")
local LogService = game:GetService("LogService")
local RunService = game:GetService("RunService")

if not RunService:IsRunning() then
	return
end

local capturedLogs = {}
local logConnection = nil

local MESSAGE_TYPE_MAP = {
	[Enum.MessageType.MessageOutput] = "output",
	[Enum.MessageType.MessageInfo] = "info",
	[Enum.MessageType.MessageWarning] = "warning",
	[Enum.MessageType.MessageError] = "error",
}

logConnection = LogService.MessageOut:Connect(function(message, messageType)
	if string.sub(message, 1, 8) == "[Bridge]" then return end
	table.insert(capturedLogs, {
		level = MESSAGE_TYPE_MAP[messageType] or "output",
		message = message,
		ts = os.clock(),
	})
end)

local startTime = os.clock()
local isTimeout = false
local ok = false
local result = nil
local testEnded = false

local function endTest()
	if testEnded then return end
	testEnded = true
	local duration = os.clock() - startTime
	task.wait(0.1)
	if logConnection then logConnection:Disconnect() end
	local errors = {}
	for _, log in ipairs(capturedLogs) do
		if log.level == "error" or log.level == "warning" then
			table.insert(errors, log)
		end
	end
	StudioTestService:EndTest({
		success = ok,
		value = if ok then tostring(result) else nil,
		error = if not ok then tostring(result) else nil,
		logs = capturedLogs,
		errors = errors,
		duration = duration,
		isTimeout = isTimeout,
	})
end

task.spawn(function()
	task.wait(]] .. timeoutStr .. [[)
	isTimeout = true
	endTest()
end)

ok, result = pcall(function()
]] .. userCode .. [[

end)

endTest()
]]
end

local function removeTestScript()
	local testScript = ServerScriptService:FindFirstChild(TEST_SCRIPT_NAME)
	if testScript then testScript:Destroy() end
end

local function injectTestScript(code: string, timeout: number)
	removeTestScript()
	local source = buildTestRunnerSource(code, timeout)
	local testScript = Instance.new("Script")
	testScript.Name = TEST_SCRIPT_NAME
	testScript.Parent = ServerScriptService
	testScript.Source = source
end

-- ── Known properties database ─────────────────────────────────────────────

local KNOWN_PROPS: {[string]: {string}} = {
	BasePart = {"Name","Parent","Position","Size","CFrame","Orientation","Color","BrickColor","Material","Transparency","Reflectance","Anchored","CanCollide","CanTouch","CanQuery","Massless","Locked","CastShadow","Shape","TopSurface","BottomSurface","CustomPhysicalProperties"},
	Part = {"Name","Parent","Position","Size","CFrame","Orientation","Color","BrickColor","Material","Transparency","Reflectance","Anchored","CanCollide","CanTouch","CanQuery","Massless","Locked","CastShadow","Shape","TopSurface","BottomSurface"},
	MeshPart = {"Name","Parent","Position","Size","CFrame","Orientation","Color","BrickColor","Material","Transparency","Reflectance","Anchored","CanCollide","MeshId","TextureID","CollisionFidelity","RenderFidelity"},
	Model = {"Name","Parent","PrimaryPart","WorldPivot"},
	Folder = {"Name","Parent"},
	Script = {"Name","Parent","Source","Enabled","RunContext","Disabled"},
	LocalScript = {"Name","Parent","Source","Enabled","Disabled"},
	ModuleScript = {"Name","Parent","Source"},
	StringValue = {"Name","Parent","Value"},
	IntValue = {"Name","Parent","Value"},
	NumberValue = {"Name","Parent","Value"},
	BoolValue = {"Name","Parent","Value"},
	ObjectValue = {"Name","Parent","Value"},
	Color3Value = {"Name","Parent","Value"},
	Vector3Value = {"Name","Parent","Value"},
	CFrameValue = {"Name","Parent","Value"},
	SpawnLocation = {"Name","Parent","Position","Size","CFrame","TeamColor","Neutral","AllowTeamChangeOnTouch","Duration","Enabled"},
	Frame = {"Name","Parent","Size","Position","AnchorPoint","BackgroundColor3","BackgroundTransparency","BorderSizePixel","Visible","ZIndex","LayoutOrder","ClipsDescendants","Active","AutomaticSize"},
	TextLabel = {"Name","Parent","Size","Position","AnchorPoint","Text","TextColor3","TextSize","Font","TextScaled","TextXAlignment","TextYAlignment","TextWrapped","RichText","BackgroundColor3","BackgroundTransparency","Visible","ZIndex","LayoutOrder"},
	TextButton = {"Name","Parent","Size","Position","AnchorPoint","Text","TextColor3","TextSize","Font","TextScaled","BackgroundColor3","BackgroundTransparency","Visible","ZIndex","LayoutOrder","Active","AutoButtonColor"},
	TextBox = {"Name","Parent","Size","Position","AnchorPoint","Text","PlaceholderText","TextColor3","TextSize","Font","TextScaled","BackgroundColor3","BackgroundTransparency","Visible","ZIndex","ClearTextOnFocus","MultiLine"},
	ImageLabel = {"Name","Parent","Size","Position","AnchorPoint","Image","ImageColor3","ImageTransparency","ScaleType","BackgroundColor3","BackgroundTransparency","Visible","ZIndex","LayoutOrder"},
	ImageButton = {"Name","Parent","Size","Position","AnchorPoint","Image","ImageColor3","ImageTransparency","ScaleType","BackgroundColor3","BackgroundTransparency","Visible","ZIndex","Active","AutoButtonColor"},
	ScreenGui = {"Name","Parent","Enabled","ResetOnSpawn","ZIndexBehavior","DisplayOrder","IgnoreGuiInset"},
	BillboardGui = {"Name","Parent","Enabled","Size","StudsOffset","Adornee","AlwaysOnTop","MaxDistance","LightInfluence"},
	SurfaceGui = {"Name","Parent","Enabled","Face","Adornee","CanvasSize","LightInfluence","AlwaysOnTop"},
	PointLight = {"Name","Parent","Color","Brightness","Range","Shadows","Enabled"},
	SpotLight = {"Name","Parent","Color","Brightness","Range","Angle","Face","Shadows","Enabled"},
	SurfaceLight = {"Name","Parent","Color","Brightness","Range","Angle","Face","Shadows","Enabled"},
	Sound = {"Name","Parent","SoundId","Volume","PlaybackSpeed","Looped","Playing","TimePosition","RollOffMaxDistance","RollOffMinDistance"},
	ParticleEmitter = {"Name","Parent","Texture","Color","Size","Transparency","Lifetime","Rate","Speed","SpreadAngle","Enabled","LightEmission","LightInfluence","RotSpeed","Rotation","Drag","Acceleration"},
	Beam = {"Name","Parent","Attachment0","Attachment1","Color","Transparency","Width0","Width1","FaceCamera","Enabled","LightEmission","LightInfluence","Segments","CurveSize0","CurveSize1"},
	Attachment = {"Name","Parent","CFrame","Position","Orientation","Visible"},
	WeldConstraint = {"Name","Parent","Part0","Part1","Enabled"},
	HingeConstraint = {"Name","Parent","Attachment0","Attachment1","ActuatorType","AngularSpeed","MotorMaxTorque","LimitsEnabled","LowerAngle","UpperAngle"},
	UIListLayout = {"Name","Parent","FillDirection","HorizontalAlignment","VerticalAlignment","SortOrder","Padding"},
	UIGridLayout = {"Name","Parent","CellSize","CellPadding","FillDirection","HorizontalAlignment","VerticalAlignment","SortOrder","FillDirectionMaxCells"},
	UIPadding = {"Name","Parent","PaddingTop","PaddingBottom","PaddingLeft","PaddingRight"},
	UICorner = {"Name","Parent","CornerRadius"},
	UIStroke = {"Name","Parent","Color","Thickness","Transparency","ApplyStrokeMode","LineJoinMode"},
	UIAspectRatioConstraint = {"Name","Parent","AspectRatio","AspectType","DominantAxis"},
	UIScale = {"Name","Parent","Scale"},
	UITextSizeConstraint = {"Name","Parent","MinTextSize","MaxTextSize"},
	UISizeConstraint = {"Name","Parent","MinSize","MaxSize"},
	Terrain = {"Name","WaterColor","WaterReflectance","WaterTransparency","WaterWaveSize","WaterWaveSpeed"},
	Humanoid = {"Name","Parent","Health","MaxHealth","WalkSpeed","JumpPower","JumpHeight","UseJumpPower","AutoRotate","HipHeight","DisplayDistanceType","HealthDisplayDistance","NameDisplayDistance"},
	Camera = {"Name","CFrame","FieldOfView","CameraType","CameraSubject","Focus"},
	Tool = {"Name","Parent","CanBeDropped","Enabled","RequiresHandle","ToolTip","Grip"},
	RemoteEvent = {"Name","Parent"},
	RemoteFunction = {"Name","Parent"},
	BindableEvent = {"Name","Parent"},
	BindableFunction = {"Name","Parent"},
	AnimationController = {"Name","Parent"},
	Animation = {"Name","Parent","AnimationId"},
	ClickDetector = {"Name","Parent","MaxActivationDistance","CursorIcon"},
	ProximityPrompt = {"Name","Parent","ActionText","ObjectText","HoldDuration","MaxActivationDistance","KeyboardKeyCode","RequiresLineOfSight","Enabled","Exclusivity","Style"},
}

-- ── Command executor ──────────────────────────────────────────────────────

local function execute(cmd: {[string]: any}): {[string]: any}
	local cmdType = cmd.type :: string

	-- run: execute arbitrary Lua with output capture (requires LoadStringEnabled)
	if cmdType == "run" then
		local code = cmd.code :: string
		local loadOk, fnOrErr = pcall(loadstring, code)
		if not loadOk then
			return { success = false, error = "LoadStringEnabled is OFF. Enable it: Game Settings > Security > Allow Server Scripts to use LoadString. Alternative: use bridge_script_edit or bridge_script_write instead.", loadStringDisabled = true }
		end
		local fn = fnOrErr :: (() -> any)?
		if not fn then return { success = false, error = "Compile error" } end

		-- Capture print/warn/error output
		local capturedOutput: {string} = {}
		local chunkfenv = getfenv(fn :: any)
		local oldPrint = print
		local oldWarn = warn

		chunkfenv.print = function(...: any)
			local args = {}
			for i = 1, select("#", ...) do
				table.insert(args, tostring(select(i, ...)))
			end
			local msg = table.concat(args, "\t")
			table.insert(capturedOutput, "[OUTPUT] " .. msg)
			oldPrint(...)
		end

		chunkfenv.warn = function(...: any)
			local args = {}
			for i = 1, select("#", ...) do
				table.insert(args, tostring(select(i, ...)))
			end
			local msg = table.concat(args, "\t")
			table.insert(capturedOutput, "[WARNING] " .. msg)
			oldWarn(...)
		end

		local ok, result = pcall(fn :: any)
		if not ok then
			table.insert(capturedOutput, "[ERROR] " .. tostring(result))
			return { success = false, error = tostring(result), output = table.concat(capturedOutput, "\n") }
		end

		local serialized = serializeValue(result)
		local resultStr: string
		if type(serialized) == "table" then
			local encOk, enc = pcall(HttpService.JSONEncode, HttpService, serialized)
			resultStr = encOk and enc or tostring(serialized)
		else
			resultStr = tostring(serialized)
		end

		if #capturedOutput > 0 then
			table.insert(capturedOutput, "[RETURNED] " .. resultStr)
			return { success = true, result = resultStr, output = table.concat(capturedOutput, "\n") }
		end
		return { success = true, result = resultStr }

	-- get_tree: serialize instance tree, configurable depth
	elseif cmdType == "get_tree" then
		local pathStr = (cmd.path or "game") :: string
		local maxDepth: number = cmd.depth or MAX_DEPTH_DEFAULT
		local withProps: boolean = cmd.props == true
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local data = serializeInstance(instOrErr :: Instance, 0, maxDepth, withProps)
		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, data)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded }

	-- get_properties: get properties of a single instance
	elseif cmdType == "get_properties" then
		local pathStr = (cmd.path or "game") :: string
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local inst = instOrErr :: Instance
		local propList: {string}? = cmd.properties
		local includeTypes: boolean = cmd.types == true
		local out = getProps(inst, propList, includeTypes)
		out.FullName = inst:GetFullName()
		out.ClassName = inst.ClassName
		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, out)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded }

	-- bulk_inspect: full tree + all props in one shot
	elseif cmdType == "bulk_inspect" then
		local pathStr = (cmd.path or "game") :: string
		local maxDepth: number = cmd.depth or MAX_DEPTH_DEFAULT
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local data = serializeInstance(instOrErr :: Instance, 0, maxDepth, true)
		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, data)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded }

	-- find: search descendants by name or class
	elseif cmdType == "find" then
		local pathStr = (cmd.path or "game") :: string
		local maxResults: number = cmd.limit or MAX_RESULTS_DEFAULT
		local withProps: boolean = cmd.props == true
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local root = instOrErr :: Instance
		local results: {{[string]: any}} = {}
		for _, desc in root:GetDescendants() do
			local nameMatch = cmd.name and string.find(desc.Name:lower(), (cmd.name :: string):lower())
			local classMatch = cmd.class and desc.ClassName == cmd.class
			if (cmd.name and nameMatch) or (cmd.class and classMatch) or (not cmd.name and not cmd.class) then
				local entry: {[string]: any} = {
					Name = desc.Name,
					ClassName = desc.ClassName,
					FullName = desc:GetFullName(),
				}
				if withProps then entry.Props = getProps(desc) end
				table.insert(results, entry)
				if #results >= maxResults then break end
			end
		end
		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, results)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded, count = #results }

	-- batch: run multiple commands in one round trip
	elseif cmdType == "batch" then
		local commands: {{[string]: any}} = cmd.commands :: {{[string]: any}}
		if not commands then return { success = false, error = "batch requires 'commands' array" } end
		local results: {{[string]: any}} = {}
		for _, subCmd in commands do
			table.insert(results, execute(subCmd))
		end
		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, results)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded }

	-- get_logs: return buffered log entries
	elseif cmdType == "get_logs" then
		local count: number = cmd.count or 50
		local clear: boolean = cmd.clear ~= false -- default true
		local filter: string? = cmd.filter
		local results: {{[string]: any}} = {}
		local start = math.max(1, #_logBuffer - count + 1)
		for i = start, #_logBuffer do
			local entry = _logBuffer[i]
			if filter then
				if not string.find(entry.message:lower(), filter:lower()) and entry.type:lower() ~= filter:lower() then
					continue
				end
			end
			table.insert(results, entry)
		end
		if clear then table.clear(_logBuffer) end
		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, results)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded, count = #results }

	-- undo: revert last bridge action (or N steps)
	elseif cmdType == "undo" then
		local steps: number = cmd.steps or 1
		for _ = 1, steps do
			ChangeHistoryService:Undo()
		end
		return { success = true, result = "Undid " .. steps .. " step(s)" }

	-- redo: reapply last undone action (or N steps)
	elseif cmdType == "redo" then
		local steps: number = cmd.steps or 1
		for _ = 1, steps do
			ChangeHistoryService:Redo()
		end
		return { success = true, result = "Redid " .. steps .. " step(s)" }

	-- insert_model: search marketplace and insert a model
	elseif cmdType == "insert_model" then
		local query: string = cmd.query
		if not query or query == "" then
			return { success = false, error = "insert_model requires 'query' string" }
		end
		local ok, nameOrErr = pcall(insertFromMarketplace, query)
		if ok then
			return { success = true, result = "Inserted model: " .. nameOrErr }
		else
			return { success = false, error = tostring(nameOrErr) }
		end

	-- start_stop_play: control play mode
	elseif cmdType == "start_stop_play" then
		local mode: string = cmd.mode
		if not mode then
			return { success = false, error = "start_stop_play requires 'mode' (start_play, run_server, stop)" }
		end
		if mode == "start_play" then
			clearConsoleBuffer()
			_studioMode = "start_play"
			task.spawn(function()
				StudioTestService:ExecutePlayModeAsync({})
			end)
			return { success = true, result = "Started play" }
		elseif mode == "run_server" then
			_studioMode = "run_server"
			task.spawn(function()
				StudioTestService:ExecuteRunModeAsync({})
			end)
			return { success = true, result = "Ran server" }
		elseif mode == "stop" then
			setPluginSetting(MCP_STOP_PLAY_KEY, true)
			_studioMode = "stop"
			return { success = true, result = "Stopped" }
		else
			return { success = false, error = "Invalid mode: " .. mode .. " (must be start_play, run_server, or stop)" }
		end

	-- run_script_in_play_mode: inject script and run play/server mode
	elseif cmdType == "run_script_in_play_mode" then
		local code: string = cmd.code
		local timeout: number = cmd.timeout or 1000000
		local mode: string = cmd.mode or "start_play"
		if not code or code == "" then
			return { success = false, error = "run_script_in_play_mode requires 'code' string" }
		end
		injectTestScript(code, timeout)
		clearConsoleBuffer()
		local success, result = pcall(function()
			if mode == "start_play" then
				_studioMode = "start_play"
				return StudioTestService:ExecutePlayModeAsync({})
			else
				_studioMode = "run_server"
				return StudioTestService:ExecuteRunModeAsync({})
			end
		end)
		_studioMode = "stop"
		removeTestScript()
		if not success then
			return { success = false, error = "Failed to run script in play mode: " .. tostring(result) }
		end
		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, result)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded }

	-- get_studio_mode: return current mode
	elseif cmdType == "get_studio_mode" then
		return { success = true, result = _studioMode }

	-- get_console_output: return accumulated console output
	elseif cmdType == "get_console_output" then
		local clear: boolean = cmd.clear == true
		local output = getConsoleOutput()
		if clear then clearConsoleBuffer() end
		return { success = true, result = output }

	-- create_instance: create instance by className, optionally set parent & properties
	elseif cmdType == "create_instance" then
		local className: string = cmd.className
		if not className or className == "" then
			return { success = false, error = "create_instance requires 'className'" }
		end
		local parentPath: string = cmd.parent or "game.Workspace"
		local name: string? = cmd.name
		local properties: {[string]: any}? = cmd.properties

		local instRef: Instance? = nil
		local createOk, createErr = pcall(function()
			local inst = Instance.new(className)
			if name then inst.Name = name end
			-- Set properties before parenting (deserialize rich types like Color3, Vector3, etc.)
			if properties then
				for prop, val in properties do
					local deserialized = deserializeValue(val, prop)
					local propOk, propErr = pcall(function() (inst :: any)[prop] = deserialized end)
					if not propOk then
						warn("[Bridge] Failed to set " .. prop .. " on " .. className .. ": " .. tostring(propErr))
					end
				end
			end
			local ok, parentOrErr = resolvePath(parentPath)
			if not ok then error("Parent not found: " .. parentPath .. " — " .. tostring(parentOrErr)) end
			inst.Parent = parentOrErr :: Instance
			instRef = inst
		end)
		if createOk and instRef then
			return { success = true, result = "Created " .. className .. " '" .. (instRef :: Instance).Name .. "' at " .. (instRef :: Instance):GetFullName() }
		end
		return { success = false, error = tostring(createErr) }

	-- delete_instance: delete instance(s) by path
	elseif cmdType == "delete_instance" then
		local pathStr: string = cmd.path
		if not pathStr or pathStr == "" then
			return { success = false, error = "delete_instance requires 'path'" }
		end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local inst = instOrErr :: Instance
		local fullName = inst:GetFullName()
		inst:Destroy()
		return { success = true, result = "Deleted " .. fullName }

	-- clone_instance: clone an instance
	elseif cmdType == "clone_instance" then
		local pathStr: string = cmd.path
		local targetParent: string? = cmd.parent
		if not pathStr or pathStr == "" then
			return { success = false, error = "clone_instance requires 'path'" }
		end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local inst = instOrErr :: Instance
		local clone = inst:Clone()
		if not clone then
			return { success = false, error = "Failed to clone (instance may not be cloneable)" }
		end
		if targetParent then
			local pOk, pInstOrErr = resolvePath(targetParent)
			if not pOk then return { success = false, error = pInstOrErr :: string } end
			clone.Parent = pInstOrErr :: Instance
		else
			clone.Parent = inst.Parent
		end
		return { success = true, result = "Cloned " .. inst:GetFullName() .. " → " .. clone:GetFullName() }

	-- set_property: set a property on an instance
	elseif cmdType == "set_property" then
		local pathStr: string = cmd.path
		local property: string = cmd.property
		local value: any = cmd.value
		if not pathStr or not property then
			return { success = false, error = "set_property requires 'path' and 'property'" }
		end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local inst = instOrErr :: Instance
		local deserialized = deserializeValue(value, property)
		local setOk, setErr = pcall(function() (inst :: any)[property] = deserialized end)
		if setOk then
			return { success = true, result = "Set " .. property .. " on " .. inst:GetFullName() }
		end
		return { success = false, error = "Failed to set " .. property .. ": " .. tostring(setErr) }

	-- move_instance: reparent an instance
	elseif cmdType == "move_instance" then
		local pathStr: string = cmd.path
		local newParent: string = cmd.parent
		if not pathStr or not newParent then
			return { success = false, error = "move_instance requires 'path' and 'parent'" }
		end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local pOk, pInstOrErr = resolvePath(newParent)
		if not pOk then return { success = false, error = pInstOrErr :: string } end
		local inst = instOrErr :: Instance
		local oldPath = inst:GetFullName()
		inst.Parent = pInstOrErr :: Instance
		return { success = true, result = "Moved " .. oldPath .. " → " .. inst:GetFullName() }

	-- rename_instance: rename an instance
	elseif cmdType == "rename_instance" then
		local pathStr: string = cmd.path
		local newName: string = cmd.name
		if not pathStr or not newName then
			return { success = false, error = "rename_instance requires 'path' and 'name'" }
		end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local inst = instOrErr :: Instance
		local oldName = inst.Name
		inst.Name = newName
		return { success = true, result = "Renamed " .. oldName .. " → " .. newName }

	-- get_selection: get currently selected instances
	elseif cmdType == "get_selection" then
		local selected = Selection:Get()
		local results: {{[string]: any}} = {}
		for _, inst in selected do
			table.insert(results, {
				Name = inst.Name,
				ClassName = inst.ClassName,
				FullName = inst:GetFullName(),
			})
		end
		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, results)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded, count = #results }

	-- set_selection: select instances by paths
	elseif cmdType == "set_selection" then
		local paths: {string} = cmd.paths
		if not paths then
			return { success = false, error = "set_selection requires 'paths' array" }
		end
		local instances: {Instance} = {}
		for _, pathStr in paths do
			local ok, instOrErr = resolvePath(pathStr)
			if ok then
				table.insert(instances, instOrErr :: Instance)
			end
		end
		Selection:Set(instances)
		return { success = true, result = "Selected " .. #instances .. " instance(s)" }

	-- get_script_source: read a script's Source property
	elseif cmdType == "get_script_source" then
		local pathStr: string = cmd.path
		if not pathStr then
			return { success = false, error = "get_script_source requires 'path'" }
		end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local inst = instOrErr :: Instance
		if not inst:IsA("LuaSourceContainer") then
			return { success = false, error = inst:GetFullName() .. " is not a script (" .. inst.ClassName .. ")" }
		end
		local source = (inst :: any).Source
		return { success = true, result = source }

	-- set_script_source: write a script's Source property
	elseif cmdType == "set_script_source" then
		local pathStr: string = cmd.path
		local source: string = cmd.source
		if not pathStr or not source then
			return { success = false, error = "set_script_source requires 'path' and 'source'" }
		end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local inst = instOrErr :: Instance
		if not inst:IsA("LuaSourceContainer") then
			return { success = false, error = inst:GetFullName() .. " is not a script (" .. inst.ClassName .. ")" }
		end
		;(inst :: any).Source = source
		return { success = true, result = "Updated source of " .. inst:GetFullName() .. " (" .. #source .. " chars)" }

	-- get_attributes: read all attributes on an instance
	elseif cmdType == "get_attributes" then
		local pathStr: string = cmd.path
		if not pathStr then
			return { success = false, error = "get_attributes requires 'path'" }
		end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local inst = instOrErr :: Instance
		local attrs: {[string]: any} = {}
		for key, val in inst:GetAttributes() do
			attrs[key] = serializeValue(val)
		end
		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, attrs)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded }

	-- set_attribute: set an attribute on an instance
	elseif cmdType == "set_attribute" then
		local pathStr: string = cmd.path
		local attribute: string = cmd.attribute
		local value: any = cmd.value
		if not pathStr or not attribute then
			return { success = false, error = "set_attribute requires 'path' and 'attribute'" }
		end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local inst = instOrErr :: Instance
		local setOk, setErr = pcall(function()
			inst:SetAttribute(attribute, deserializeValue(value))
		end)
		if setOk then
			return { success = true, result = "Set attribute '" .. attribute .. "' on " .. inst:GetFullName() }
		end
		return { success = false, error = "Failed to set attribute: " .. tostring(setErr) }

	-- delete_attribute: remove an attribute
	elseif cmdType == "delete_attribute" then
		local pathStr: string = cmd.path
		local attribute: string = cmd.attribute
		if not pathStr or not attribute then
			return { success = false, error = "delete_attribute requires 'path' and 'attribute'" }
		end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local inst = instOrErr :: Instance
		inst:SetAttribute(attribute, nil)
		return { success = true, result = "Removed attribute '" .. attribute .. "' from " .. inst:GetFullName() }

	-- get_children: lightweight child list without full tree serialization
	elseif cmdType == "get_children" then
		local pathStr: string = cmd.path or "game"
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local inst = instOrErr :: Instance
		local children: {{[string]: any}} = {}
		for _, child in inst:GetChildren() do
			table.insert(children, {
				Name = child.Name,
				ClassName = child.ClassName,
				ChildCount = #child:GetChildren(),
			})
		end
		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, children)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded, count = #children }

	-- game_map: high-level game structure overview for agent orientation
	elseif cmdType == "game_map" then
		local services = {
			"Workspace", "ServerScriptService", "ServerStorage",
			"ReplicatedStorage", "ReplicatedFirst", "StarterGui",
			"StarterPack", "StarterPlayer", "Lighting",
			"SoundService", "Chat", "Teams",
		}
		local map: {{[string]: any}} = {}
		for _, svcName in services do
			local svc = game:FindFirstChild(svcName)
			if svc then
				local children = svc:GetChildren()
				local descendants = svc:GetDescendants()
				local scripts = 0
				local localScripts = 0
				local moduleScripts = 0
				for _, desc in descendants do
					if desc:IsA("ModuleScript") then
						moduleScripts += 1
					elseif desc:IsA("LocalScript") then
						localScripts += 1
					elseif desc:IsA("Script") then
						scripts += 1
					end
				end
				local topChildren: {{[string]: string}} = {}
				for i, child in children do
					if i > 20 then break end
					table.insert(topChildren, { Name = child.Name, ClassName = child.ClassName })
				end
				local totalScripts = scripts + localScripts + moduleScripts
				table.insert(map, {
					Service = svcName,
					ChildCount = #children,
					DescendantCount = #descendants,
					ScriptCount = totalScripts,
					Scripts = scripts,
					LocalScripts = localScripts,
					ModuleScripts = moduleScripts,
					TopChildren = topChildren,
				})
			end
		end
		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, map)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded }

	-- scan_scripts: discover all scripts with metadata and optionally source code
	elseif cmdType == "scan_scripts" then
		local pathStr = (cmd.path or "game") :: string
		local includeSources: boolean = cmd.sources == true
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local rootInst = instOrErr :: Instance
		local scripts: {{[string]: any}} = {}
		for _, desc in rootInst:GetDescendants() do
			if desc:IsA("LuaSourceContainer") then
				local entry: {[string]: any} = {
					Name = desc.Name,
					ClassName = desc.ClassName,
					FullName = desc:GetFullName(),
				}
				local src = (desc :: any).Source :: string
				entry.LineCount = #string.split(src, "\n")
				entry.CharCount = #src
				if includeSources then
					entry.Source = src
				end
				table.insert(scripts, entry)
			end
		end
		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, scripts)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded, count = #scripts }

	-- search_code: grep across all script source code
	elseif cmdType == "search_code" then
		local pathStr = (cmd.path or "game") :: string
		local pattern: string = cmd.pattern
		if not pattern or pattern == "" then
			return { success = false, error = "search_code requires 'pattern' string" }
		end
		local maxResults: number = cmd.limit or 50
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local rootInst = instOrErr :: Instance
		local results: {{[string]: any}} = {}
		for _, desc in rootInst:GetDescendants() do
			if desc:IsA("LuaSourceContainer") then
				local src = (desc :: any).Source :: string
				local lineNum = 0
				for line in string.gmatch(src .. "\n", "([^\n]*)\n") do
					lineNum += 1
					if string.find(line:lower(), pattern:lower(), 1, true) then
						table.insert(results, {
							Script = desc:GetFullName(),
							ClassName = desc.ClassName,
							Line = lineNum,
							Text = line,
						})
						if #results >= maxResults then break end
					end
				end
				if #results >= maxResults then break end
			end
		end
		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, results)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded, count = #results }

	-- script_edit: find-and-replace text within a script source
	elseif cmdType == "script_edit" then
		local pathStr: string = cmd.path
		local findStr: string = cmd.find
		local replaceStr: string = cmd.replace or ""
		if not pathStr or not findStr then
			return { success = false, error = "script_edit requires 'path' and 'find'" }
		end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local inst = instOrErr :: Instance
		if not inst:IsA("LuaSourceContainer") then
			return { success = false, error = inst:GetFullName() .. " is not a script (" .. inst.ClassName .. ")" }
		end
		local src = (inst :: any).Source :: string
		local startIdx, endIdx = string.find(src, findStr, 1, true)
		if not startIdx or not endIdx then
			return { success = false, error = "Text not found in script source" }
		end
		local newSrc = string.sub(src, 1, startIdx - 1) .. replaceStr .. string.sub(src, endIdx + 1)
		;(inst :: any).Source = newSrc

		-- Build diff context: show 3 lines before/after the edit location
		local lines = string.split(newSrc, "\n")
		-- Find which line the edit starts on
		local editLine = 1
		local charCount = 0
		for i, line in lines do
			charCount += #line + 1 -- +1 for newline
			if charCount >= startIdx then
				editLine = i
				break
			end
		end
		local contextStart = math.max(1, editLine - 3)
		local contextEnd = math.min(#lines, editLine + 3)
		local contextLines: {string} = {}
		for i = contextStart, contextEnd do
			local prefix = (i == editLine) and ">> " or "   "
			table.insert(contextLines, prefix .. tostring(i) .. ": " .. lines[i])
		end
		local context = table.concat(contextLines, "\n")

		return { success = true, result = "Edited " .. inst:GetFullName() .. " (" .. #newSrc .. " chars, line " .. editLine .. ")\n\n" .. context }

	-- require_graph: trace require() dependencies across all scripts
	elseif cmdType == "require_graph" then
		local pathStr = (cmd.path or "game") :: string
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local rootInst = instOrErr :: Instance

		-- Build a lookup from FullName -> script info
		local scriptMap: {[string]: {[string]: any}} = {}
		local allScripts: {Instance} = {}
		for _, desc in rootInst:GetDescendants() do
			if desc:IsA("LuaSourceContainer") then
				table.insert(allScripts, desc)
				scriptMap[desc:GetFullName()] = {
					Name = desc.Name,
					ClassName = desc.ClassName,
					FullName = desc:GetFullName(),
				}
			end
		end

		local graph: {{[string]: any}} = {}
		for _, scriptInst in allScripts do
			local src = (scriptInst :: any).Source :: string
			local requires: {{[string]: any}} = {}

			-- Match require(path) patterns
			-- Patterns: require(script.Parent.Module), require(game.ReplicatedStorage.Module)
			for reqPath in string.gmatch(src, "require%(([^%)]+)%)") do
				local trimmed = reqPath:match("^%s*(.-)%s*$") or reqPath
				-- Try to resolve the require path
				local resolved: string? = nil

				-- Handle script.Parent.X patterns by resolving relative to this script
				if string.sub(trimmed, 1, 7) == "script." then
					local relPath = string.sub(trimmed, 8) -- remove "script."
					local current: Instance? = scriptInst
					local parts = string.split(relPath, ".")
					local resolveOk = true
					for _, part in parts do
						if not current then resolveOk = false; break end
						if part == "Parent" then
							current = current.Parent
						else
							current = (current :: Instance):FindFirstChild(part)
						end
					end
					if resolveOk and current then
						resolved = current:GetFullName()
					end
				-- Handle game.X.Y.Z absolute paths
				elseif string.sub(trimmed, 1, 5) == "game." or string.sub(trimmed, 1, 5) == "game:" then
					local resolvePathOk, resolvedInst = resolvePath(trimmed)
					if resolvePathOk then
						resolved = (resolvedInst :: Instance):GetFullName()
					end
				end

				table.insert(requires, {
					Raw = trimmed,
					Resolved = resolved,
				})
			end

			if #requires > 0 then
				table.insert(graph, {
					Script = scriptInst:GetFullName(),
					ClassName = scriptInst.ClassName,
					Requires = requires,
				})
			end
		end

		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, graph)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded, count = #graph }

	-- get_class_info: return known settable properties for a ClassName
	elseif cmdType == "get_class_info" then
		local className: string = cmd.className
		if not className then
			return { success = false, error = "get_class_info requires 'className'" }
		end
		-- If an instance path is given, also read live property types from the actual instance
		local liveProps: {[string]: string}? = nil
		if cmd.path then
			local ok, instOrErr = resolvePath(cmd.path :: string)
			if ok then
				liveProps = {}
				local inst = instOrErr :: Instance
				local knownList = KNOWN_PROPS[className] or COMMON_PROPS
				for _, p in knownList do
					local pOk, val = pcall(function(): any return (inst :: any)[p] end)
					if pOk and val ~= nil then
						(liveProps :: {[string]: string})[p] = typeof(val)
					end
				end
			end
		end
		local propsList = KNOWN_PROPS[className]
		local result: {[string]: any} = {
			ClassName = className,
			Known = propsList ~= nil,
			Properties = propsList or {},
		}
		if liveProps then result.PropertyTypes = liveProps end
		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, result)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded }

	-- get_capabilities: report what the plugin can do
	elseif cmdType == "get_capabilities" then
		local result: {[string]: any} = {
			PluginVersion = PLUGIN_VERSION,
			LoadStringEnabled = _loadStringEnabled,
			IsRunning = RunService:IsRunning(),
			KnownClasses = {},
		}
		for className, _ in KNOWN_PROPS do
			table.insert(result.KnownClasses :: {string}, className)
		end
		table.sort(result.KnownClasses :: {string})
		local encOk, encoded = pcall(HttpService.JSONEncode, HttpService, result)
		if not encOk then return { success = false, error = encoded } end
		return { success = true, result = encoded }

	-- get_tags: read CollectionService tags on an instance
	elseif cmdType == "get_tags" then
		local pathStr: string = cmd.path
		if not pathStr then return { success = false, error = "get_tags requires 'path'" } end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local tags = CollectionService:GetTags(instOrErr :: Instance)
		local encOk2, encoded2 = pcall(HttpService.JSONEncode, HttpService, tags)
		if not encOk2 then return { success = false, error = encoded2 } end
		return { success = true, result = encoded2 }

	-- add_tag: add a CollectionService tag to an instance
	elseif cmdType == "add_tag" then
		local pathStr: string = cmd.path
		local tag: string = cmd.tag
		if not pathStr or not tag then return { success = false, error = "add_tag requires 'path' and 'tag'" } end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		CollectionService:AddTag(instOrErr :: Instance, tag)
		return { success = true, result = "Added tag '" .. tag .. "' to " .. (instOrErr :: Instance):GetFullName() }

	-- remove_tag: remove a CollectionService tag from an instance
	elseif cmdType == "remove_tag" then
		local pathStr: string = cmd.path
		local tag: string = cmd.tag
		if not pathStr or not tag then return { success = false, error = "remove_tag requires 'path' and 'tag'" } end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		CollectionService:RemoveTag(instOrErr :: Instance, tag)
		return { success = true, result = "Removed tag '" .. tag .. "' from " .. (instOrErr :: Instance):GetFullName() }

	-- find_tagged: find all instances with a specific tag
	elseif cmdType == "find_tagged" then
		local tag: string = cmd.tag
		if not tag then return { success = false, error = "find_tagged requires 'tag'" } end
		local tagged = CollectionService:GetTagged(tag)
		local limit: number = cmd.limit or 50
		local results: {{[string]: any}} = {}
		for i, inst in tagged do
			if i > limit then break end
			table.insert(results, { Name = inst.Name, ClassName = inst.ClassName, FullName = inst:GetFullName() })
		end
		local encOk2, encoded2 = pcall(HttpService.JSONEncode, HttpService, results)
		if not encOk2 then return { success = false, error = encoded2 } end
		return { success = true, result = encoded2, count = #results }

	-- tween: animate properties over time using TweenService
	elseif cmdType == "tween" then
		local pathStr: string = cmd.path
		local properties: {[string]: any} = cmd.properties
		local duration: number = cmd.duration or 1
		local easingStyle: string = cmd.easingStyle or "Quad"
		local easingDirection: string = cmd.easingDirection or "Out"
		local shouldWait: boolean = cmd.wait == true
		if not pathStr or not properties then
			return { success = false, error = "tween requires 'path' and 'properties'" }
		end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local inst = instOrErr :: Instance
		local tweenProps: {[string]: any} = {}
		for prop, val in properties do
			tweenProps[prop] = deserializeValue(val, prop)
		end
		local style = (Enum.EasingStyle :: any)[easingStyle] or Enum.EasingStyle.Quad
		local direction = (Enum.EasingDirection :: any)[easingDirection] or Enum.EasingDirection.Out
		local tweenInfo = TweenInfo.new(duration, style, direction)
		local tween = TweenService:Create(inst, tweenInfo, tweenProps)
		tween:Play()
		if shouldWait then
			tween.Completed:Wait()
			return { success = true, result = "Tween completed on " .. inst:GetFullName() .. " (" .. duration .. "s)" }
		end
		return { success = true, result = "Tween started on " .. inst:GetFullName() .. " (" .. duration .. "s)" }

	-- raycast: cast a ray and return what it hits
	elseif cmdType == "raycast" then
		local origin: {[string]: number} = cmd.origin
		local direction: {[string]: number} = cmd.direction
		if not origin or not direction then
			return { success = false, error = "raycast requires 'origin' {x,y,z} and 'direction' {x,y,z}" }
		end
		local originVec = Vector3.new(origin.x or 0, origin.y or 0, origin.z or 0)
		local dirVec = Vector3.new(direction.x or 0, direction.y or 0, direction.z or 0)
		local params = RaycastParams.new()
		if cmd.filterType == "exclude" then
			params.FilterType = Enum.RaycastFilterType.Exclude
		elseif cmd.filterType == "include" then
			params.FilterType = Enum.RaycastFilterType.Include
		end
		if cmd.filterPaths then
			local filterInstances: {Instance} = {}
			for _, fp in cmd.filterPaths :: {string} do
				local fpOk, fpInst = resolvePath(fp)
				if fpOk then table.insert(filterInstances, fpInst :: Instance) end
			end
			params.FilterDescendantsInstances = filterInstances
		end
		local rayResult = workspace:Raycast(originVec, dirVec, params)
		if rayResult then
			local hitData: {[string]: any} = {
				Hit = true,
				Instance = rayResult.Instance:GetFullName(),
				ClassName = rayResult.Instance.ClassName,
				Position = { x = rayResult.Position.X, y = rayResult.Position.Y, z = rayResult.Position.Z },
				Normal = { x = rayResult.Normal.X, y = rayResult.Normal.Y, z = rayResult.Normal.Z },
				Material = tostring(rayResult.Material),
				Distance = (rayResult.Position - originVec).Magnitude,
			}
			local encOk2, encoded2 = pcall(HttpService.JSONEncode, HttpService, hitData)
			if not encOk2 then return { success = false, error = encoded2 } end
			return { success = true, result = encoded2 }
		end
		return { success = true, result = HttpService:JSONEncode({ Hit = false, Distance = dirVec.Magnitude }) }

	-- set_properties: set multiple properties on one instance at once
	elseif cmdType == "set_properties" then
		local pathStr: string = cmd.path
		local properties: {[string]: any} = cmd.properties
		if not pathStr or not properties then
			return { success = false, error = "set_properties requires 'path' and 'properties' object" }
		end
		local ok, instOrErr = resolvePath(pathStr)
		if not ok then return { success = false, error = instOrErr :: string } end
		local inst = instOrErr :: Instance
		local setCount = 0
		local errors: {string} = {}
		for prop, val in properties do
			local deserialized = deserializeValue(val, prop)
			local setOk, setErr = pcall(function() (inst :: any)[prop] = deserialized end)
			if setOk then
				setCount += 1
			else
				table.insert(errors, prop .. ": " .. tostring(setErr))
			end
		end
		if #errors > 0 then
			return { success = true, result = "Set " .. setCount .. " properties on " .. inst:GetFullName() .. ", " .. #errors .. " failed: " .. table.concat(errors, "; ") }
		end
		return { success = true, result = "Set " .. setCount .. " properties on " .. inst:GetFullName() }

	-- ── fill_terrain: fill a region with terrain material ─────────────────
	elseif cmdType == "fill_terrain" then
		local Terrain = game.Workspace.Terrain
		local shape: string = cmd.shape or "block"
		local material: string = cmd.material or "Grass"
		local mat = (Enum.Material :: any)[material]
		if not mat then return { success = false, error = "Unknown material: " .. material } end

		if shape == "block" then
			local pos = cmd.position or { x = 0, y = 0, z = 0 }
			local sz = cmd.size or { x = 10, y = 10, z = 10 }
			local cf = CFrame.new(pos.x, pos.y, pos.z)
			local size = Vector3.new(sz.x, sz.y, sz.z)
			Terrain:FillBlock(cf, size, mat)
		elseif shape == "ball" then
			local pos = cmd.position or { x = 0, y = 0, z = 0 }
			local radius: number = cmd.radius or 10
			Terrain:FillBall(Vector3.new(pos.x, pos.y, pos.z), radius, mat)
		elseif shape == "cylinder" then
			local pos = cmd.position or { x = 0, y = 0, z = 0 }
			local height: number = cmd.height or 10
			local radius: number = cmd.radius or 5
			local cf = CFrame.new(pos.x, pos.y, pos.z)
			Terrain:FillCylinder(cf, height, radius, mat)
		elseif shape == "clear" then
			local pos = cmd.position or { x = 0, y = 0, z = 0 }
			local sz = cmd.size or { x = 50, y = 50, z = 50 }
			local region = Region3.new(
				Vector3.new(pos.x - sz.x/2, pos.y - sz.y/2, pos.z - sz.z/2),
				Vector3.new(pos.x + sz.x/2, pos.y + sz.y/2, pos.z + sz.z/2)
			)
			Terrain:FillRegion(region:ExpandToGrid(4), 4, Enum.Material.Air)
		else
			return { success = false, error = "Unknown shape: " .. shape .. " (block, ball, cylinder, clear)" }
		end
		return { success = true, result = "Filled terrain " .. shape .. " with " .. material }

	-- ── replace_terrain: replace one material with another ────────────────
	elseif cmdType == "replace_terrain" then
		local Terrain = game.Workspace.Terrain
		local pos = cmd.position or { x = 0, y = 0, z = 0 }
		local sz = cmd.size or { x = 100, y = 100, z = 100 }
		local fromMat: string = cmd.from or "Grass"
		local toMat: string = cmd.to or "Sand"
		local from = (Enum.Material :: any)[fromMat]
		local to = (Enum.Material :: any)[toMat]
		if not from or not to then return { success = false, error = "Unknown material" } end
		local region = Region3.new(
			Vector3.new(pos.x - sz.x/2, pos.y - sz.y/2, pos.z - sz.z/2),
			Vector3.new(pos.x + sz.x/2, pos.y + sz.y/2, pos.z + sz.z/2)
		)
		Terrain:ReplaceMaterial(region:ExpandToGrid(4), 4, from, to)
		return { success = true, result = "Replaced " .. fromMat .. " with " .. toMat }

	-- ── set_lighting: configure lighting + post-processing ────────────────
	elseif cmdType == "set_lighting" then
		local Lighting = game:GetService("Lighting")
		local props = cmd.properties or {}
		local setCount = 0
		local errors: {string} = {}
		for prop, val in props do
			local deserialized = deserializeValue(val, prop)
			local ok2, err2 = pcall(function() (Lighting :: any)[prop] = deserialized end)
			if ok2 then setCount += 1 else table.insert(errors, prop .. ": " .. tostring(err2)) end
		end
		-- Also support setting child effect properties
		local effects = cmd.effects or {}
		for effectName, effectProps in effects do
			local effect = Lighting:FindFirstChild(effectName)
			if not effect then
				-- Create the effect if it doesn't exist
				local className = cmd.effectClasses and cmd.effectClasses[effectName] or effectName
				local ok3, inst3 = pcall(function() return Instance.new(className) end)
				if ok3 and inst3 then
					local inst = inst3 :: Instance
					inst.Name = effectName
					inst.Parent = Lighting
					effect = inst
				end
			end
			if effect then
				for prop, val in effectProps do
					local deserialized = deserializeValue(val, prop)
					pcall(function() (effect :: any)[prop] = deserialized end)
					setCount += 1
				end
			end
		end
		if #errors > 0 then
			return { success = true, result = "Set " .. setCount .. " lighting properties (" .. #errors .. " failed)" }
		end
		return { success = true, result = "Set " .. setCount .. " lighting properties" }

	-- ── play_sound: play/stop/create sounds ───────────────────────────────
	elseif cmdType == "play_sound" then
		local action: string = cmd.action or "play"
		local soundPath: string? = cmd.path
		local soundId: string? = cmd.soundId

		if action == "create" then
			local pOk, parent = resolvePath(cmd.parent or "game.Workspace")
			if not pOk then return { success = false, error = tostring(parent) } end
			local sound = Instance.new("Sound")
			sound.Name = cmd.name or "Sound"
			if soundId then sound.SoundId = soundId end
			sound.Volume = cmd.volume or 0.5
			sound.Looped = cmd.looped or false
			sound.PlaybackSpeed = cmd.playbackSpeed or 1
			sound.Parent = parent :: Instance
			if cmd.autoPlay then sound:Play() end
			return { success = true, result = "Created sound: " .. sound:GetFullName() }
		end

		-- Find the sound
		local sound: Instance? = nil
		if soundPath then
			local sOk, resolved = resolvePath(soundPath)
			if sOk then sound = resolved :: Instance end
		end
		if not sound or not sound:IsA("Sound") then
			return { success = false, error = "Sound not found at: " .. tostring(soundPath) }
		end

		if action == "play" then
			(sound :: Sound):Play()
		elseif action == "stop" then
			(sound :: Sound):Stop()
		elseif action == "pause" then
			(sound :: Sound):Pause()
		elseif action == "resume" then
			(sound :: Sound):Resume()
		else
			return { success = false, error = "Unknown action: " .. action }
		end
		return { success = true, result = action .. ": " .. sound:GetFullName() }

	-- ── build_gui: create UI hierarchy from declarative spec ──────────────
	elseif cmdType == "build_gui" then
		local spec = cmd.spec
		if not spec then return { success = false, error = "build_gui requires 'spec' object" } end
		local created = 0

		local function buildNode(nodeSpec: {[string]: any}, parent: Instance): Instance?
			local className: string = nodeSpec.className or "Frame"
			local ok2, inst2 = pcall(function() return Instance.new(className) end)
			if not ok2 or not inst2 then return nil end
			local instance = inst2 :: Instance
			instance.Name = nodeSpec.name or className
			-- Set properties
			local props = nodeSpec.properties or {}
			for prop, val in props do
				pcall(function() (instance :: any)[prop] = deserializeValue(val, prop) end)
			end
			instance.Parent = parent
			created += 1
			-- Recursively create children
			local children = nodeSpec.children or {}
			for _, childSpec in children do
				buildNode(childSpec, instance)
			end
			return instance
		end

		local parentPath: string = cmd.parent or "game.StarterGui"
		local pOk, parent = resolvePath(parentPath)
		if not pOk then return { success = false, error = tostring(parent) } end
		local root = buildNode(spec, parent :: Instance)
		if root then
			return { success = true, result = "Created GUI hierarchy: " .. (root :: Instance):GetFullName() .. " (" .. created .. " instances)" }
		end
		return { success = false, error = "Failed to create root GUI instance" }

	-- ── create_constraint: create physics constraint between parts ────────
	elseif cmdType == "create_constraint" then
		local constraintType: string = cmd.constraintType or "WeldConstraint"
		local part0Path: string = cmd.part0
		local part1Path: string = cmd.part1
		if not part0Path or not part1Path then
			return { success = false, error = "create_constraint requires 'part0' and 'part1' paths" }
		end
		local p0Ok, part0 = resolvePath(part0Path)
		if not p0Ok then return { success = false, error = tostring(part0) } end
		local p1Ok, part1 = resolvePath(part1Path)
		if not p1Ok then return { success = false, error = tostring(part1) } end

		local ok2, constraint = pcall(function() return Instance.new(constraintType) end)
		if not ok2 or not constraint then
			return { success = false, error = "Unknown constraint type: " .. constraintType }
		end

		-- WeldConstraint uses Part0/Part1 directly
		local cAny: any = constraint
		if constraintType == "WeldConstraint" then
			cAny.Part0 = part0
			cAny.Part1 = part1
		else
			-- Other constraints need attachments
			local att0 = Instance.new("Attachment")
			att0.Name = "ConstraintAttachment0"
			att0.Parent = part0 :: Instance
			local att1 = Instance.new("Attachment")
			att1.Name = "ConstraintAttachment1"
			att1.Parent = part1 :: Instance
			cAny.Attachment0 = att0
			cAny.Attachment1 = att1
		end

		-- Set extra properties
		local props = cmd.properties or {}
		for prop, val in props do
			pcall(function() (constraint :: any)[prop] = deserializeValue(val, prop) end)
		end

		local c = constraint :: Instance
		c.Name = cmd.name or constraintType
		c.Parent = part0 :: Instance
		return { success = true, result = "Created " .. constraintType .. " between " .. (part0 :: Instance):GetFullName() .. " and " .. (part1 :: Instance):GetFullName() }

	-- ── create_particles: create particle emitter with presets ────────────
	elseif cmdType == "create_particles" then
		local parentPath: string = cmd.parent or "game.Workspace"
		local pOk, parent = resolvePath(parentPath)
		if not pOk then return { success = false, error = tostring(parent) } end

		local preset: string = cmd.preset or "custom"
		local emitter = Instance.new("ParticleEmitter")
		emitter.Name = cmd.name or "ParticleEmitter"

		-- Presets
		if preset == "fire" then
			emitter.Rate = 80
			emitter.Lifetime = NumberRange.new(0.5, 1.5)
			emitter.Speed = NumberRange.new(3, 8)
			emitter.SpreadAngle = Vector2.new(15, 15)
			emitter.LightEmission = 0.8
			emitter.Color = ColorSequence.new(Color3.fromRGB(255, 120, 0), Color3.fromRGB(255, 0, 0))
			emitter.Size = NumberSequence.new({NumberSequenceKeypoint.new(0, 1), NumberSequenceKeypoint.new(1, 0)})
			emitter.Transparency = NumberSequence.new({NumberSequenceKeypoint.new(0, 0.3), NumberSequenceKeypoint.new(1, 1)})
		elseif preset == "smoke" then
			emitter.Rate = 30
			emitter.Lifetime = NumberRange.new(2, 4)
			emitter.Speed = NumberRange.new(1, 3)
			emitter.SpreadAngle = Vector2.new(30, 30)
			emitter.Color = ColorSequence.new(Color3.fromRGB(100, 100, 100))
			emitter.Size = NumberSequence.new({NumberSequenceKeypoint.new(0, 0.5), NumberSequenceKeypoint.new(1, 3)})
			emitter.Transparency = NumberSequence.new({NumberSequenceKeypoint.new(0, 0.4), NumberSequenceKeypoint.new(1, 1)})
		elseif preset == "sparkle" then
			emitter.Rate = 40
			emitter.Lifetime = NumberRange.new(0.5, 1)
			emitter.Speed = NumberRange.new(5, 15)
			emitter.SpreadAngle = Vector2.new(180, 180)
			emitter.LightEmission = 1
			emitter.Color = ColorSequence.new(Color3.fromRGB(255, 255, 100))
			emitter.Size = NumberSequence.new({NumberSequenceKeypoint.new(0, 0.3), NumberSequenceKeypoint.new(1, 0)})
		elseif preset == "rain" then
			emitter.Rate = 100
			emitter.Lifetime = NumberRange.new(1, 2)
			emitter.Speed = NumberRange.new(20, 30)
			emitter.SpreadAngle = Vector2.new(5, 5)
			emitter.Rotation = NumberRange.new(0, 0)
			emitter.Color = ColorSequence.new(Color3.fromRGB(150, 180, 255))
			emitter.Size = NumberSequence.new(0.1)
			emitter.Transparency = NumberSequence.new(0.5)
		elseif preset == "snow" then
			emitter.Rate = 50
			emitter.Lifetime = NumberRange.new(3, 6)
			emitter.Speed = NumberRange.new(2, 5)
			emitter.SpreadAngle = Vector2.new(40, 40)
			emitter.Color = ColorSequence.new(Color3.fromRGB(245, 245, 255))
			emitter.Size = NumberSequence.new(0.2)
			emitter.RotSpeed = NumberRange.new(-60, 60)
		end

		-- Custom properties override preset
		local props = cmd.properties or {}
		for prop, val in props do
			pcall(function() (emitter :: any)[prop] = deserializeValue(val, prop) end)
		end

		emitter.Parent = parent :: Instance
		return { success = true, result = "Created " .. preset .. " particle emitter: " .. emitter:GetFullName() }

	-- ── save_snapshot: serialize a subtree to JSON ────────────────────────
	elseif cmdType == "save_snapshot" then
		local targetPath: string = cmd.path or "game.Workspace"
		local tOk, target = resolvePath(targetPath)
		if not tOk then return { success = false, error = tostring(target) } end
		local maxDepth: number = cmd.depth or 10

		local function snapshotNode(inst: Instance, depth: number): {[string]: any}
			local node: {[string]: any} = {
				Name = inst.Name,
				ClassName = inst.ClassName,
				Properties = {},
			}
			-- Capture key properties
			for _, propName in {"Position", "Size", "CFrame", "Color", "BrickColor", "Material", "Transparency", "Anchored", "CanCollide", "Enabled", "Visible", "Text", "Value"} do
				pcall(function()
					local val = (inst :: any)[propName]
					node.Properties[propName] = serializeValue(val)
				end)
			end
			if depth > 0 then
				node.Children = {}
				for _, child in inst:GetChildren() do
					table.insert(node.Children, snapshotNode(child, depth - 1))
				end
			end
			return node
		end

		local snapshot = snapshotNode(target :: Instance, maxDepth)
		return { success = true, result = HttpService:JSONEncode(snapshot) }

	-- ── compare_snapshot: compare current state with a saved snapshot ─────
	elseif cmdType == "compare_snapshot" then
		local targetPath: string = cmd.path or "game.Workspace"
		local tOk, target = resolvePath(targetPath)
		if not tOk then return { success = false, error = tostring(target) } end
		local snapshot = cmd.snapshot
		if not snapshot then return { success = false, error = "No snapshot provided" } end

		local diffs: {{[string]: any}} = {}
		local function compareNode(inst: Instance, snap: {[string]: any}, path: string)
			-- Check name/class
			if inst.Name ~= snap.Name then
				table.insert(diffs, { path = path, field = "Name", expected = snap.Name, actual = inst.Name })
			end
			if inst.ClassName ~= snap.ClassName then
				table.insert(diffs, { path = path, field = "ClassName", expected = snap.ClassName, actual = inst.ClassName })
			end
			-- Check properties
			local snapProps = snap.Properties or {}
			for propName, expectedVal in snapProps do
				pcall(function()
					local actualVal = serializeValue((inst :: any)[propName])
					local expected = HttpService:JSONEncode(expectedVal)
					local actual = HttpService:JSONEncode(actualVal)
					if expected ~= actual then
						table.insert(diffs, { path = path, field = propName, expected = expectedVal, actual = actualVal })
					end
				end)
			end
			-- Check children
			local snapChildren = snap.Children or {}
			local instChildren = inst:GetChildren()
			-- Check for missing children
			for _, childSnap in snapChildren do
				local found = false
				for _, child in instChildren do
					if child.Name == childSnap.Name and child.ClassName == childSnap.ClassName then
						compareNode(child, childSnap, path .. "." .. child.Name)
						found = true
						break
					end
				end
				if not found then
					table.insert(diffs, { path = path, change = "removed", name = childSnap.Name, className = childSnap.ClassName })
				end
			end
			-- Check for new children
			for _, child in instChildren do
				local found = false
				for _, childSnap in snapChildren do
					if child.Name == childSnap.Name and child.ClassName == childSnap.ClassName then
						found = true
						break
					end
				end
				if not found then
					table.insert(diffs, { path = path, change = "added", name = child.Name, className = child.ClassName })
				end
			end
		end
		compareNode(target :: Instance, snapshot, targetPath)
		if #diffs == 0 then
			return { success = true, result = "No differences found" }
		end
		return { success = true, result = HttpService:JSONEncode(diffs) }

	-- ── export_tree: export subtree as JSON ───────────────────────────────
	elseif cmdType == "export_tree" then
		local targetPath: string = cmd.path or "game.Workspace"
		local tOk, target = resolvePath(targetPath)
		if not tOk then return { success = false, error = tostring(target) } end
		local maxDepth: number = cmd.depth or 20
		local includeSource: boolean = cmd.includeSource == true

		local function exportNode(inst: Instance, depth: number): {[string]: any}
			local node: {[string]: any} = {
				Name = inst.Name,
				ClassName = inst.ClassName,
			}
			-- Export all known properties for this class
			local classProps = KNOWN_PROPS[inst.ClassName]
			if classProps then
				local props: {[string]: any} = {}
				for _, propName in classProps do
					if propName == "Parent" then continue end
					pcall(function()
						props[propName] = serializeValue((inst :: any)[propName])
					end)
				end
				node.Properties = props
			end
			-- Scripts: include source
			if includeSource and (inst:IsA("LuaSourceContainer")) then
				pcall(function() node.Source = (inst :: any).Source end)
			end
			-- Children
			if depth > 0 then
				local children: {{[string]: any}} = {}
				for _, child in inst:GetChildren() do
					table.insert(children, exportNode(child, depth - 1))
				end
				if #children > 0 then node.Children = children end
			end
			return node
		end

		local exported = exportNode(target :: Instance, maxDepth)
		return { success = true, result = HttpService:JSONEncode(exported) }

	-- ── create_animation: create KeyframeSequence with poses ──────────────
	elseif cmdType == "create_animation" then
		local parentPath: string = cmd.parent or "game.Workspace"
		local pOk, parent = resolvePath(parentPath)
		if not pOk then return { success = false, error = tostring(parent) } end

		local kfs = Instance.new("KeyframeSequence")
		kfs.Name = cmd.name or "Animation"
		kfs.Loop = cmd.loop or false
		kfs.Priority = (Enum.AnimationPriority :: any)[cmd.priority or "Action"] or Enum.AnimationPriority.Action

		local keyframes = cmd.keyframes or {}
		for _, kfData in keyframes do
			local kf = Instance.new("Keyframe")
			kf.Time = kfData.time or 0
			kf.Name = kfData.name or "Keyframe"
			local poses = kfData.poses or {}
			for _, poseData in poses do
				local pose = Instance.new("Pose")
				pose.Name = poseData.part or "HumanoidRootPart"
				if poseData.cframe then
					local cf = poseData.cframe
					pose.CFrame = CFrame.new(cf.x or 0, cf.y or 0, cf.z or 0) * CFrame.Angles(
						math.rad(cf.rx or 0), math.rad(cf.ry or 0), math.rad(cf.rz or 0)
					)
				end
				pose.Weight = poseData.weight or 1
				pose.EasingStyle = (Enum.PoseEasingStyle :: any)[poseData.easing or "Linear"] or Enum.PoseEasingStyle.Linear
				pose.Parent = kf
			end
			kf.Parent = kfs
		end

		kfs.Parent = parent :: Instance
		return { success = true, result = "Created animation '" .. kfs.Name .. "' with " .. #keyframes .. " keyframes at " .. kfs:GetFullName() }

	-- start_character_control: inject a control loop script and enter play mode
	elseif cmdType == "start_character_control" then
		local mode: string = cmd.mode or "start_play"
		local timeout: number = cmd.timeout or 300
		local scanRadius: number = cmd.scanRadius or 30
		local scanDirections: number = cmd.scanDirections or 8

		-- Build the control loop script
		local controlSource = [[
--!strict
-- BAD Bridge Character Control Script (auto-injected, removed after session)
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local StudioTestService = game:GetService("StudioTestService")
local CollectionService = game:GetService("CollectionService")

if not RunService:IsRunning() then return end

local SERVER = "http://localhost:]] .. tostring(_port) .. [["
local SCAN_RADIUS = ]] .. tostring(scanRadius) .. [[

local SCAN_DIRECTIONS = ]] .. tostring(scanDirections) .. [[

local SESSION_TIMEOUT = ]] .. tostring(timeout) .. [[

local startTime = os.clock()
local running = true

-- Wait for player
local player: Player? = nil
if #Players:GetPlayers() > 0 then
	player = Players:GetPlayers()[1]
else
	player = Players.PlayerAdded:Wait()
end
if not player then
	StudioTestService:EndTest({ success = false, error = "No player found" })
	return
end

-- Wait for character
local character = (player :: Player).Character or (player :: Player).CharacterAdded:Wait()
if not character then
	StudioTestService:EndTest({ success = false, error = "No character" })
	return
end
local humanoid = character:WaitForChild("Humanoid", 10) :: Humanoid?
local rootPart = character:WaitForChild("HumanoidRootPart", 10) :: BasePart?
if not humanoid or not rootPart then
	StudioTestService:EndTest({ success = false, error = "No humanoid or root part" })
	return
end

-- Respawn handler
local plr = player :: Player
plr.CharacterAdded:Connect(function(newChar: Model)
	character = newChar
	humanoid = newChar:WaitForChild("Humanoid", 10) :: Humanoid?
	rootPart = newChar:WaitForChild("HumanoidRootPart", 10) :: BasePart?
end)

-- Scan nearby instances
local function scanNearby(): {{[string]: any}}
	local results: {{[string]: any}} = {}
	if not rootPart then return results end
	local pos = rootPart.Position
	for _, inst in workspace:GetDescendants() do
		if inst == character or inst:IsDescendantOf(character :: Instance) then continue end
		if inst:IsA("BasePart") then
			local dist = (inst.Position - pos).Magnitude
			if dist <= SCAN_RADIUS and #results < 30 then
				local tags = CollectionService:GetTags(inst)
				local entry: {[string]: any} = {
					Name = inst.Name,
					ClassName = inst.ClassName,
					Distance = math.floor(dist * 10) / 10,
					Position = { x = math.floor(inst.Position.X*10)/10, y = math.floor(inst.Position.Y*10)/10, z = math.floor(inst.Position.Z*10)/10 },
					Size = { x = inst.Size.X, y = inst.Size.Y, z = inst.Size.Z },
				}
				if #tags > 0 then entry.Tags = tags end
				-- Check for ProximityPrompt
				local pp = inst:FindFirstChildOfClass("ProximityPrompt")
				if pp then entry.HasPrompt = true; entry.PromptText = (pp :: any).ActionText end
				-- Check for ClickDetector
				if inst:FindFirstChildOfClass("ClickDetector") then entry.HasClickDetector = true end
				table.insert(results, entry)
			end
		elseif inst:IsA("Model") and inst.PrimaryPart then
			local dist = (inst.PrimaryPart.Position - pos).Magnitude
			if dist <= SCAN_RADIUS and #results < 30 then
				local entry: {[string]: any} = {
					Name = inst.Name,
					ClassName = inst.ClassName,
					Distance = math.floor(dist * 10) / 10,
					Position = { x = math.floor(inst.PrimaryPart.Position.X*10)/10, y = math.floor(inst.PrimaryPart.Position.Y*10)/10, z = math.floor(inst.PrimaryPart.Position.Z*10)/10 },
				}
				if inst:FindFirstChildOfClass("Humanoid") then entry.IsNPC = true end
				table.insert(results, entry)
			end
		end
	end
	table.sort(results, function(a, b) return (a.Distance :: number) < (b.Distance :: number) end)
	return results
end

-- Directional raycasts for spatial awareness
local function scanRays(): {{[string]: any}}
	if not rootPart then return {} end
	local results: {{[string]: any}} = {}
	local pos = rootPart.Position + Vector3.new(0, 2, 0) -- eye level
	local params = RaycastParams.new()
	params.FilterDescendantsInstances = { character :: Instance }
	params.FilterType = Enum.RaycastFilterType.Exclude

	-- Down ray (ground check)
	local downResult = workspace:Raycast(rootPart.Position, Vector3.new(0, -50, 0), params)
	if downResult then
		table.insert(results, {
			Direction = "down",
			Hit = downResult.Instance.Name,
			ClassName = downResult.Instance.ClassName,
			Distance = math.floor((downResult.Position - rootPart.Position).Magnitude * 10) / 10,
			Material = tostring(downResult.Material),
		})
	else
		table.insert(results, { Direction = "down", Hit = "none", Distance = 50 })
	end

	-- Horizontal rays
	for i = 0, SCAN_DIRECTIONS - 1 do
		local angle = (i / SCAN_DIRECTIONS) * math.pi * 2
		local dir = Vector3.new(math.cos(angle), 0, math.sin(angle)) * 50
		local dirName = ""
		if i == 0 then dirName = "east"
		elseif i == 1 then dirName = "southeast"
		elseif i == 2 then dirName = "south"
		elseif i == 3 then dirName = "southwest"
		elseif i == 4 then dirName = "west"
		elseif i == 5 then dirName = "northwest"
		elseif i == 6 then dirName = "north"
		elseif i == 7 then dirName = "northeast"
		else dirName = "dir" .. i end

		local rayResult = workspace:Raycast(pos, dir, params)
		if rayResult then
			table.insert(results, {
				Direction = dirName,
				Hit = rayResult.Instance.Name,
				ClassName = rayResult.Instance.ClassName,
				Distance = math.floor((rayResult.Position - pos).Magnitude * 10) / 10,
			})
		else
			table.insert(results, { Direction = dirName, Hit = "none", Distance = 50 })
		end
	end

	-- Forward ray (based on character facing direction)
	local lookDir = rootPart.CFrame.LookVector * 50
	local fwdResult = workspace:Raycast(pos, lookDir, params)
	if fwdResult then
		table.insert(results, {
			Direction = "forward",
			Hit = fwdResult.Instance.Name,
			ClassName = fwdResult.Instance.ClassName,
			Distance = math.floor((fwdResult.Position - pos).Magnitude * 10) / 10,
		})
	else
		table.insert(results, { Direction = "forward", Hit = "none", Distance = 50 })
	end

	return results
end

-- Build state report
local function getState(): {[string]: any}
	local state: {[string]: any} = { active = true, timestamp = os.clock() - startTime }
	if not rootPart or not humanoid or not character then
		state.alive = false
		return state
	end
	state.alive = humanoid.Health > 0
	state.health = humanoid.Health
	state.maxHealth = humanoid.MaxHealth
	state.position = { x = math.floor(rootPart.Position.X*10)/10, y = math.floor(rootPart.Position.Y*10)/10, z = math.floor(rootPart.Position.Z*10)/10 }
	state.velocity = math.floor(rootPart.AssemblyLinearVelocity.Magnitude * 10) / 10
	state.facing = {
		x = math.floor(rootPart.CFrame.LookVector.X*100)/100,
		y = math.floor(rootPart.CFrame.LookVector.Y*100)/100,
		z = math.floor(rootPart.CFrame.LookVector.Z*100)/100,
	}
	state.moveState = tostring(humanoid:GetState())
	state.isGrounded = humanoid.FloorMaterial ~= Enum.Material.Air
	state.walkSpeed = humanoid.WalkSpeed
	state.jumpPower = humanoid.JumpPower

	-- Equipped tool
	local tool = character:FindFirstChildOfClass("Tool")
	if tool then
		state.equippedTool = tool.Name
	end

	-- Backpack
	local backpack: {string} = {}
	local bp = plr:FindFirstChild("Backpack")
	if bp then
		for _, item in bp:GetChildren() do
			if item:IsA("Tool") then table.insert(backpack, item.Name) end
		end
	end
	if tool then table.insert(backpack, tool.Name .. " (equipped)") end
	state.backpack = backpack

	return state
end

-- Push state to bridge server
local function pushState()
	local state = getState()
	pcall(function()
		HttpService:PostAsync(
			SERVER .. "/control/state",
			HttpService:JSONEncode(state),
			Enum.HttpContentType.ApplicationJson
		)
	end)
end

-- Process a control input
local function processInput(input: {[string]: any})
	local action = input.action :: string
	if not action then return end

	if action == "move_to" and rootPart and humanoid then
		local x = input.x :: number? or rootPart.Position.X
		local y = input.y :: number?
		local z = input.z :: number? or rootPart.Position.Z
		if y then
			humanoid:MoveTo(Vector3.new(x, y, z))
		else
			humanoid:MoveTo(Vector3.new(x, rootPart.Position.Y, z))
		end

	elseif action == "move_direction" and rootPart and humanoid then
		local dx = input.x :: number? or 0
		local dz = input.z :: number? or 0
		local moveDir = Vector3.new(dx, 0, dz)
		if moveDir.Magnitude > 0 then
			moveDir = moveDir.Unit
		end
		humanoid:Move(moveDir)

	elseif action == "jump" and humanoid then
		humanoid.Jump = true

	elseif action == "look_at" and rootPart then
		local x = input.x :: number? or rootPart.Position.X
		local y = input.y :: number?
		local z = input.z :: number? or rootPart.Position.Z
		local targetPos = Vector3.new(x, y or rootPart.Position.Y, z)
		rootPart.CFrame = CFrame.lookAt(rootPart.Position, targetPos)

	elseif action == "teleport" and rootPart then
		local x = input.x :: number? or 0
		local y = input.y :: number? or 0
		local z = input.z :: number? or 0
		rootPart.CFrame = CFrame.new(x, y, z)

	elseif action == "stop_moving" and humanoid then
		humanoid:Move(Vector3.zero)
		if rootPart then
			humanoid:MoveTo(rootPart.Position)
		end

	elseif action == "equip" then
		local toolName = input.tool :: string?
		if not toolName then return end
		local bp = plr:FindFirstChild("Backpack")
		if bp then
			local tool = bp:FindFirstChild(toolName)
			if tool and tool:IsA("Tool") then
				humanoid:EquipTool(tool)
			end
		end

	elseif action == "unequip" and humanoid then
		humanoid:UnequipTools()

	elseif action == "use_tool" and character then
		local tool = character:FindFirstChildOfClass("Tool")
		if tool then
			tool:Activate()
		end

	elseif action == "interact" then
		local targetPath = input.target :: string?
		if targetPath then
			local target: Instance? = nil
			-- Try by path
			local current: Instance = game
			for _, part in string.split(targetPath, ".") do
				if part == "game" then continue end
				local child = current:FindFirstChild(part)
				if child then current = child else break end
			end
			if current ~= game then target = current end

			if target then
				-- ProximityPrompt
				local pp = target:FindFirstChildOfClass("ProximityPrompt")
				if not pp and target:IsA("ProximityPrompt") then pp = target end
				if pp then
					local prompt: any = pp
					prompt:InputHoldBegin()
					task.wait(prompt.HoldDuration + 0.1)
					prompt:InputHoldEnd()
					return
				end
				-- ClickDetector
				local cd = target:FindFirstChildOfClass("ClickDetector")
				if not cd and target:IsA("ClickDetector") then cd = target end
				if cd and player then
					local detector: any = cd
					detector:Fire(plr.UserId)
				end
			end
		end

	elseif action == "wait" then
		local duration = input.duration :: number? or 1
		task.wait(duration)

	elseif action == "stop_session" then
		running = false
	end
end

-- State push loop (separate thread, pushes state every 0.3s)
task.spawn(function()
	while running do
		pushState()
		task.wait(0.3)
	end
end)

-- Main control loop
while running do
	if os.clock() - startTime > SESSION_TIMEOUT then
		running = false
		break
	end

	-- Poll for input from bridge server (short timeout to avoid Roblox script timeout)
	local pollOk, pollResp = pcall(function()
		return HttpService:RequestAsync({
			Url = SERVER .. "/control/poll?timeout=800",
			Method = "GET",
			Headers = { ["Cache-Control"] = "no-cache" },
		})
	end)

	if pollOk and pollResp and pollResp.Success then
		local body = pollResp.Body
		if body and body ~= "" and body ~= "null" and body ~= "\"null\"" then
			local decOk, input = pcall(HttpService.JSONDecode, HttpService, body)
			if decOk and input then
				local inputOk, inputErr = pcall(processInput, input)
				if not inputOk then
					warn("[Bridge Control] Input error: " .. tostring(inputErr))
				end
			end
		end
	end

	-- CRITICAL: yield to prevent script timeout
	task.wait(0.1)
end

-- Final state push
pushState()
StudioTestService:EndTest({ success = true, value = "Control session ended", duration = os.clock() - startTime })
]]

		-- Inject the control script
		removeTestScript()
		local testScript = Instance.new("Script")
		testScript.Name = TEST_SCRIPT_NAME
		testScript.Parent = ServerScriptService
		testScript.Source = controlSource

		clearConsoleBuffer()

		-- Start play mode (non-blocking, the control script runs inside play mode)
		task.spawn(function()
			local ok, err = pcall(function()
				if mode == "start_play" then
					_studioMode = "start_play"
					StudioTestService:ExecutePlayModeAsync({})
				else
					_studioMode = "run_server"
					StudioTestService:ExecuteRunModeAsync({})
				end
			end)
			_studioMode = "stop"
			removeTestScript()
		end)

		return { success = true, result = "Character control session started (timeout: " .. timeout .. "s). Use bridge_character_control with actions: move_to, move_direction, jump, look_at, teleport, interact, equip, use_tool, state, stop." }

	-- stop_character_control: end the control session
	elseif cmdType == "stop_character_control" then
		-- Send stop command via the control input queue
		pcall(function()
			HttpService:PostAsync(
				_server .. "/control/input",
				HttpService:JSONEncode({ action = "stop_session" }),
				Enum.HttpContentType.ApplicationJson
			)
		end)
		-- Also trigger stop play
		setPluginSetting(MCP_STOP_PLAY_KEY, true)
		_studioMode = "stop"
		-- Clear control state
		pcall(function()
			HttpService:RequestAsync({
				Url = _server .. "/control",
				Method = "DELETE",
			})
		end)
		return { success = true, result = "Character control session stopped" }
	end

	return { success = false, error = "Unknown command: " .. tostring(cmdType) }
end

-- ── Poll loop ─────────────────────────────────────────────────────────────

local function startPolling()
	if _polling then return end

	local portNum = tonumber(portInput.Text)
	if not portNum or portNum < 1 or portNum > 65535 then
		warn("[Bridge] Invalid port: " .. portInput.Text)
		return
	end
	_port = portNum
	_server = "http://localhost:" .. _port
	_polling = true
	_connected = false
	_cmdCount = 0
	_consecutiveFailures = 0
	startConsoleListener()
	updateUI()
	print("[Bridge] Plugin v" .. PLUGIN_VERSION .. " started - polling", _server)

	task.spawn(function()
		while _polling do
			task.wait(POLL_INTERVAL)

			local pollOk, response = pcall(function(): string
				local resp = HttpService:RequestAsync({
					Url = _server .. "/poll",
					Method = "GET",
					Headers = { ["Cache-Control"] = "no-cache" },
				})
				if resp.Success then
					return resp.Body
				else
					error("HTTP " .. tostring(resp.StatusCode))
				end
				return ""
			end)

			if not pollOk then
				_consecutiveFailures += 1
				if _connected and _consecutiveFailures >= POLL_FAIL_TOLERANCE then
					warn("[Bridge] Connection interrupted — reconnecting... (" .. tostring(_consecutiveFailures) .. " consecutive failures)")
					_connected = false
					updateUI()
				end
				-- Gentle backoff: 0.5s → 5s max
				task.wait(_reconnectDelay)
				_reconnectDelay = math.min(_reconnectDelay * 1.3, RECONNECT_DELAY_MAX)
				continue
			end
			_consecutiveFailures = 0
			_reconnectDelay = RECONNECT_DELAY_BASE -- reset on success

			if not _connected then
				print("[Bridge] Connected to bridge server on port", _port)
				_connected = true
				updateUI()
			end

			-- Push buffered logs at a rate-limited interval
			local now = os.clock()
			if #_logBuffer > 0 and (now - _lastLogPush) >= LOG_PUSH_INTERVAL then
				_lastLogPush = now
				local logsToSend = table.clone(_logBuffer)
				table.clear(_logBuffer)
				pcall(function()
					HttpService:PostAsync(
						_server .. "/logs",
						HttpService:JSONEncode(logsToSend),
						Enum.HttpContentType.ApplicationJson
					)
				end)
				updateUI()
			end

			if not response or response == "" or response == "null" then
				continue
			end

			-- Process all queued commands (drain loop)
			local currentResponse: string? = response
			while currentResponse and currentResponse ~= "" and currentResponse ~= "null" do
			local decodeOk, cmd = pcall(HttpService.JSONDecode, HttpService, currentResponse)
			if not decodeOk or not cmd then break end

			local cmdType = cmd.type or "?"
			print("[Bridge] Executing:", cmdType)

			local readOnly = cmdType == "get_tree" or cmdType == "get_properties"
				or cmdType == "bulk_inspect" or cmdType == "find"
				or cmdType == "undo" or cmdType == "redo" or cmdType == "get_logs"
				or cmdType == "get_studio_mode" or cmdType == "get_console_output"
				or cmdType == "get_selection" or cmdType == "get_script_source"
				or cmdType == "get_attributes" or cmdType == "get_children"
				or cmdType == "scan_scripts" or cmdType == "search_code"
				or cmdType == "game_map" or cmdType == "require_graph"
				or cmdType == "get_class_info" or cmdType == "get_capabilities"
				or cmdType == "get_tags" or cmdType == "find_tagged" or cmdType == "raycast"
				or cmdType == "save_snapshot" or cmdType == "compare_snapshot"
				or cmdType == "export_tree" or cmdType == "play_sound"

			local recordId: string? = nil
			if not readOnly then
				recordId = ChangeHistoryService:TryBeginRecording("Bridge: " .. cmdType)
			end

			local result = execute(cmd)
			_cmdCount += 1
			updateUI()

			if recordId then
				if result.success then
					ChangeHistoryService:FinishRecording(recordId, Enum.FinishRecordingOperation.Commit)
				else
					ChangeHistoryService:FinishRecording(recordId, Enum.FinishRecordingOperation.Cancel)
				end
			end

			pcall(function()
				HttpService:PostAsync(
					_server .. "/result",
					HttpService:JSONEncode(result),
					Enum.HttpContentType.ApplicationJson
				)
			end)

			-- Immediately poll for next queued command (drain)
			local nextOk, nextResp = pcall(function(): string
				local resp = HttpService:RequestAsync({
					Url = _server .. "/poll",
					Method = "GET",
					Headers = { ["Cache-Control"] = "no-cache" },
				})
				if resp.Success then return resp.Body end
				return ""
			end)
			if nextOk then
				currentResponse = nextResp
			else
				currentResponse = nil
			end
			end -- end drain loop
		end

		_connected = false
		updateUI()
		print("[Bridge] Polling stopped")
	end)
end

local function stopPolling()
	_polling = false
	_connected = false
	_consecutiveFailures = 0
	stopConsoleListener()
	updateUI()
end

-- ── Button wiring ─────────────────────────────────────────────────────────

connectBtn.Activated:Connect(startPolling)
disconnectBtn.Activated:Connect(stopPolling)

undoBtn.Activated:Connect(function()
	ChangeHistoryService:Undo()
end)

redoBtn.Activated:Connect(function()
	ChangeHistoryService:Redo()
end)

clearBtn.Activated:Connect(function()
	if _connected then
		pcall(function()
			HttpService:RequestAsync({
				Url = _server .. "/queue",
				Method = "DELETE",
			})
		end)
	end
	print("[Bridge] Queue cleared")
end)

-- Auto-connect on plugin load
task.defer(startPolling)
