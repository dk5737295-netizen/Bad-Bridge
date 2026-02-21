--!strict
-- Build And Defend — Studio Bridge Plugin v5
-- Dockable widget UI with port config, connect/disconnect, undo/redo,
-- status indicator, log streaming, instance manipulation, script editing,
-- play controls, attribute support, and full command support.

local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local InsertService = game:GetService("InsertService")
local LogService = game:GetService("LogService")
local RunService = game:GetService("RunService")
local Selection = game:GetService("Selection")
local ServerScriptService = game:GetService("ServerScriptService")
local StudioTestService = game:GetService("StudioTestService")

-- ── State ─────────────────────────────────────────────────────────────────

local _port = 3001
local _server = "http://localhost:" .. _port
local _polling = false
local _connected = false
local _cmdCount = 0
local POLL_INTERVAL = 0.15
local MAX_DEPTH_DEFAULT = 6
local MAX_RESULTS_DEFAULT = 100
local PLUGIN_VERSION = 5
local RECONNECT_DELAY_BASE = 1
local RECONNECT_DELAY_MAX = 10
local _reconnectDelay = RECONNECT_DELAY_BASE

local _logBuffer: {{[string]: any}} = {}
local MAX_LOG_BUFFER = 500

-- Studio mode & console output (from MCP features)
local _studioMode: string = "stop" -- "start_play" | "run_server" | "stop"
local _consoleOutput: string = ""
local DEBUG_TOOL_MAX_OUTPUT = 10000

-- Console output listener
local _consoleConn: RBXScriptConnection? = nil
local function startConsoleListener()
	if _consoleConn then return end
	_consoleConn = LogService.MessageOut:Connect(function(message: string, _: Enum.MessageType)
		if #_consoleOutput + #message <= DEBUG_TOOL_MAX_OUTPUT then
			if #_consoleOutput == 0 then
				_consoleOutput = message
			else
				_consoleOutput = _consoleOutput .. "\n" .. message
			end
		end
	end)
end
startConsoleListener()

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
	if #_logBuffer > MAX_LOG_BUFFER then
		table.remove(_logBuffer, 1)
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
	for i, part in parts do
		if i == 1 and part == "game" then continue end
		local child = current:FindFirstChild(part)
		if not child then
			return false, ("Not found: " .. part .. " in " .. pathStr)
		end
		current = child
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

local function getProps(inst: Instance, propList: {string}?): {[string]: any}
	local props = propList or COMMON_PROPS
	local out: {[string]: any} = {}
	for _, p in props do
		local ok, val = pcall(function(): any return (inst :: any)[p] end)
		if ok and val ~= nil then out[p] = serializeValue(val) end
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

local function endTest()
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
	wait(]] .. timeoutStr .. [[)
	isTimeout = true
	endTest()
end)

local ok, result = pcall(function()
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

-- ── Command executor ──────────────────────────────────────────────────────

local function execute(cmd: {[string]: any}): {[string]: any}
	local cmdType = cmd.type :: string

	-- run: execute arbitrary Lua with output capture (requires LoadStringEnabled)
	if cmdType == "run" then
		local code = cmd.code :: string
		local loadOk, fnOrErr = pcall(loadstring, code)
		if not loadOk then
			return { success = false, error = "loadstring not available - enable it in Game Settings > Security > Allow Server Scripts To Use LoadString" }
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

		local ok, result = pcall(fn :: any, code)
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
		local out = getProps(inst, propList)
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
			_consoleOutput = ""
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
		_consoleOutput = ""
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
		local output = _consoleOutput
		if clear then _consoleOutput = "" end
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

		local createOk, createErr = pcall(function()
			local inst = Instance.new(className)
			if name then inst.Name = name end
			-- Set properties before parenting
			if properties then
				for prop, val in properties do
					pcall(function() (inst :: any)[prop] = val end)
				end
			end
			local ok, parentOrErr = resolvePath(parentPath)
			if not ok then error("Parent not found: " .. parentPath) end
			inst.Parent = parentOrErr :: Instance
		end)
		if createOk then
			return { success = true, result = "Created " .. className .. " in " .. parentPath }
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
		(inst :: any).Source = source
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
	updateUI()
	print("[Bridge] Plugin v" .. PLUGIN_VERSION .. " started - polling", _server)

	task.spawn(function()
		while _polling do
			task.wait(POLL_INTERVAL)

			local pollOk, response = pcall(function(): string
				return HttpService:GetAsync(_server .. "/poll", true)
			end)

			if not pollOk then
				if _connected then
					warn("[Bridge] Lost connection to bridge server")
					_connected = false
					updateUI()
				end
				-- Exponential backoff on disconnect
				task.wait(_reconnectDelay)
				_reconnectDelay = math.min(_reconnectDelay * 1.5, RECONNECT_DELAY_MAX)
				continue
			end
			_reconnectDelay = RECONNECT_DELAY_BASE -- reset on success

			if not _connected then
				print("[Bridge] Connected to bridge server on port", _port)
				_connected = true
				updateUI()
			end

			-- Push buffered logs even when idle
			if #_logBuffer > 0 then
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

			local decodeOk, cmd = pcall(HttpService.JSONDecode, HttpService, response)
			if not decodeOk or not cmd then continue end

			local cmdType = cmd.type or "?"
			print("[Bridge] Executing:", cmdType)

			local readOnly = cmdType == "get_tree" or cmdType == "get_properties"
				or cmdType == "bulk_inspect" or cmdType == "find"
				or cmdType == "undo" or cmdType == "redo" or cmdType == "get_logs"
				or cmdType == "get_studio_mode" or cmdType == "get_console_output"
				or cmdType == "get_selection" or cmdType == "get_script_source"
				or cmdType == "get_attributes" or cmdType == "get_children"

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
		end

		_connected = false
		updateUI()
		print("[Bridge] Polling stopped")
	end)
end

local function stopPolling()
	_polling = false
	_connected = false
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
