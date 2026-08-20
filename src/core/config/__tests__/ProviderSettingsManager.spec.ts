// npx vitest src/core/config/__tests__/ProviderSettingsManager.spec.ts

import { ExtensionContext } from "vscode"

import type { ProviderSettings } from "@openai-agent/types"

import { ProviderSettingsManager, ProviderProfiles } from "../ProviderSettingsManager"

// Mock VSCode ExtensionContext
const mockSecrets = {
	get: vi.fn(),
	store: vi.fn(),
	delete: vi.fn(),
}

const mockGlobalState = {
	get: vi.fn(),
	update: vi.fn(),
}

const mockContext = {
	secrets: mockSecrets,
	globalState: mockGlobalState,
} as unknown as ExtensionContext

describe("ProviderSettingsManager", () => {
	let providerSettingsManager: ProviderSettingsManager

	beforeEach(() => {
		vi.clearAllMocks()
		// Reset all mock implementations to default successful behavior
		mockSecrets.get.mockResolvedValue(null)
		mockSecrets.store.mockResolvedValue(undefined)
		mockSecrets.delete.mockResolvedValue(undefined)
		mockGlobalState.get.mockReturnValue(undefined)
		mockGlobalState.update.mockResolvedValue(undefined)

		providerSettingsManager = new ProviderSettingsManager(mockContext)
	})

	describe("initialize", () => {
		it("should not write to storage when secrets.get returns null", async () => {
			// Mock readConfig to return null
			mockSecrets.get.mockResolvedValueOnce(null)

			await providerSettingsManager.initialize()

			// Should not write to storage because readConfig returns defaultConfig
			expect(mockSecrets.store).not.toHaveBeenCalled()
		})

		it("should not initialize config if it exists and migrations are complete", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {
							config: {},
							id: "default",
						},
					},
					modeApiConfigs: {},
					migrations: {
						rateLimitSecondsMigrated: true,
						consecutiveMistakeLimitMigrated: true,
						todoListEnabledMigrated: true,
						claudeCodeLegacySettingsMigrated: true,
					},
				}),
			)

			await providerSettingsManager.initialize()

			expect(mockSecrets.store).not.toHaveBeenCalled()
		})

		it("should generate IDs for configs that lack them", async () => {
			// Mock a config with missing IDs
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {
							config: {},
						},
						test: {
							apiProvider: "openai",
						},
					},
					migrations: {
						rateLimitSecondsMigrated: true,
					},
				}),
			)

			await providerSettingsManager.initialize()

			// Should have written the config with new IDs
			expect(mockSecrets.store).toHaveBeenCalled()
			const calls = mockSecrets.store.mock.calls
			const storedConfig = JSON.parse(calls[calls.length - 1][1]) // Get the latest call
			expect(storedConfig.apiConfigs.default.id).toBeTruthy()
			expect(storedConfig.apiConfigs.test.id).toBeTruthy()
		})

		it("should call migrateRateLimitSeconds if it has not done so already", async () => {
			mockGlobalState.get.mockResolvedValue(42)

			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {
							config: {},
							id: "default",
							rateLimitSeconds: undefined,
						},
						test: {
							apiProvider: "openai",
							rateLimitSeconds: undefined,
						},
						existing: {
							apiProvider: "openai",
							// this should not really be possible, unless someone has loaded a hand edited config,
							// but we don't overwrite so we'll check that
							rateLimitSeconds: 43,
						},
					},
					migrations: {
						rateLimitSecondsMigrated: false,
					},
				}),
			)

			await providerSettingsManager.initialize()

			// Get the last call to store, which should contain the migrated config
			const calls = mockSecrets.store.mock.calls
			const storedConfig = JSON.parse(calls[calls.length - 1][1])
			expect(storedConfig.apiConfigs.default.rateLimitSeconds).toEqual(42)
			expect(storedConfig.apiConfigs.test.rateLimitSeconds).toEqual(42)
			expect(storedConfig.apiConfigs.existing.rateLimitSeconds).toEqual(43)
		})

		it("should call migrateConsecutiveMistakeLimit if it has not done so already", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {
							config: {},
							id: "default",
							consecutiveMistakeLimit: undefined,
						},
						test: {
							apiProvider: "openai",
							consecutiveMistakeLimit: undefined,
						},
						existing: {
							apiProvider: "openai",
							// this should not really be possible, unless someone has loaded a hand edited config,
							// but we don't overwrite so we'll check that
							consecutiveMistakeLimit: 5,
						},
					},
					migrations: {
						rateLimitSecondsMigrated: true,
						consecutiveMistakeLimitMigrated: false,
					},
				}),
			)

			await providerSettingsManager.initialize()

			// Get the last call to store, which should contain the migrated config
			const calls = mockSecrets.store.mock.calls
			const storedConfig = JSON.parse(calls[calls.length - 1][1])
			expect(storedConfig.apiConfigs.default.consecutiveMistakeLimit).toEqual(3)
			expect(storedConfig.apiConfigs.test.consecutiveMistakeLimit).toEqual(3)
			expect(storedConfig.apiConfigs.existing.consecutiveMistakeLimit).toEqual(5)
			expect(storedConfig.migrations.consecutiveMistakeLimitMigrated).toEqual(true)
		})

		it("should call migrateTodoListEnabled if it has not done so already", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {
							config: {},
							id: "default",
							todoListEnabled: undefined,
						},
						test: {
							apiProvider: "openai",
							todoListEnabled: undefined,
						},
						existing: {
							apiProvider: "openai",
							// this should not really be possible, unless someone has loaded a hand edited config,
							// but we don't overwrite so we'll check that
							todoListEnabled: false,
						},
					},
					migrations: {
						rateLimitSecondsMigrated: true,
						consecutiveMistakeLimitMigrated: true,
						todoListEnabledMigrated: false,
					},
				}),
			)

			await providerSettingsManager.initialize()

			// Get the last call to store, which should contain the migrated config
			const calls = mockSecrets.store.mock.calls
			const storedConfig = JSON.parse(calls[calls.length - 1][1])
			expect(storedConfig.apiConfigs.default.todoListEnabled).toEqual(true)
			expect(storedConfig.apiConfigs.test.todoListEnabled).toEqual(true)
			expect(storedConfig.apiConfigs.existing.todoListEnabled).toEqual(false)
			expect(storedConfig.migrations.todoListEnabledMigrated).toEqual(true)
		})

		it("should throw error if secrets storage fails", async () => {
			mockSecrets.get.mockRejectedValue(new Error("Storage failed"))

			await expect(providerSettingsManager.initialize()).rejects.toThrow(
				"Failed to initialize config: Error: Failed to read provider profiles from secrets: Error: Storage failed",
			)
		})
	})

	describe("ListConfig", () => {
		it("should list all available configs", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: {
						id: "default",
					},
					test: {
						apiProvider: "openai",
						id: "test-id",
					},
				},
				modeApiConfigs: {
					code: "default",
					architect: "default",
					ask: "default",
				},
				migrations: {
					rateLimitSecondsMigrated: false,
				},
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const configs = await providerSettingsManager.listConfig()
			expect(configs).toEqual([
				{ name: "default", id: "default", apiProvider: undefined },
				{ name: "test", id: "test-id", apiProvider: "openai" },
			])
		})

		it("should handle empty config file", async () => {
			const emptyConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {},
				modeApiConfigs: {
					code: "default",
					architect: "default",
					ask: "default",
				},
				migrations: {
					rateLimitSecondsMigrated: false,
				},
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(emptyConfig))

			const configs = await providerSettingsManager.listConfig()
			expect(configs).toEqual([])
		})

		it("should throw error if reading from secrets fails", async () => {
			mockSecrets.get.mockRejectedValue(new Error("Read failed"))

			await expect(providerSettingsManager.listConfig()).rejects.toThrow(
				"Failed to list configs: Error: Failed to read provider profiles from secrets: Error: Read failed",
			)
		})
	})

	describe("SaveConfig", () => {
		it("should save new config", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {},
					},
					modeApiConfigs: {
						code: "default",
						architect: "default",
						ask: "default",
					},
				}),
			)

			const newConfig: ProviderSettings = {
				apiProvider: "openai",
				apiModelId: "gemini-2.5-flash-preview-05-20",
			}

			await providerSettingsManager.saveConfig("test", newConfig)

			// Get the actual stored config to check the generated ID
			const storedConfig = JSON.parse(mockSecrets.store.mock.calls[0][1])
			const testConfigId = storedConfig.apiConfigs.test.id

			const expectedConfig = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: {},
					test: {
						...newConfig,
						id: testConfigId,
					},
				},
				modeApiConfigs: {
					code: "default",
					architect: "default",
					ask: "default",
				},
			}

			expect(mockSecrets.store.mock.calls[0][0]).toEqual("openai_agent_config_api_config")
			expect(storedConfig).toEqual(expectedConfig)
		})

		it("should only save provider relevant settings", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {},
					},
					modeApiConfigs: {
						code: "default",
						architect: "default",
						ask: "default",
					},
				}),
			)

			const newConfig: ProviderSettings = {
				apiProvider: "openai",
				openAiApiKey: "test-key",
			}
			const newConfigWithExtra: ProviderSettings = {
				...newConfig,
			}

			await providerSettingsManager.saveConfig("test", newConfigWithExtra)

			// Get the actual stored config to check the generated ID
			const storedConfig = JSON.parse(mockSecrets.store.mock.calls[mockSecrets.store.mock.calls.length - 1][1])
			const testConfigId = storedConfig.apiConfigs.test.id

			const expectedConfig = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: {},
					test: {
						...newConfig,
						id: testConfigId,
					},
				},
				modeApiConfigs: {
					code: "default",
					architect: "default",
					ask: "default",
				},
			}

			expect(mockSecrets.store.mock.calls[0][0]).toEqual("openai_agent_config_api_config")
			expect(storedConfig).toEqual(expectedConfig)
		})

		it("should update existing config", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					test: {
						apiProvider: "openai",
						openAiApiKey: "old-key",
						id: "test-id",
					},
				},
				migrations: {
					rateLimitSecondsMigrated: false,
				},
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const updatedConfig: ProviderSettings = {
				apiProvider: "openai",
				openAiApiKey: "new-key",
			}

			await providerSettingsManager.saveConfig("test", updatedConfig)

			const expectedConfig = {
				currentApiConfigName: "default",
				apiConfigs: {
					test: {
						apiProvider: "openai",
						openAiApiKey: "new-key",
						id: "test-id",
					},
				},
				migrations: {
					rateLimitSecondsMigrated: false,
				},
			}

			const storedConfig = JSON.parse(mockSecrets.store.mock.calls[mockSecrets.store.mock.calls.length - 1][1])
			expect(mockSecrets.store.mock.calls[mockSecrets.store.mock.calls.length - 1][0]).toEqual(
				"openai_agent_config_api_config",
			)
			expect(storedConfig).toEqual(expectedConfig)
		})

		it("should throw error if secrets storage fails", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: {} },
					migrations: {
						rateLimitSecondsMigrated: true,
					},
				}),
			)
			mockSecrets.store.mockRejectedValue(new Error("Storage failed"))

			await expect(providerSettingsManager.saveConfig("test", {})).rejects.toThrow(
				"Failed to save config: Error: Failed to write provider profiles to secrets: Error: Storage failed",
			)
		})
	})

	describe("DeleteConfig", () => {
		it("should delete existing config", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					default: {
						id: "default",
					},
					test: {
						apiProvider: "openai",
						id: "test-id",
					},
				},
				migrations: {
					rateLimitSecondsMigrated: false,
				},
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			await providerSettingsManager.deleteConfig("test")

			// Get the stored config to check the ID
			const storedConfig = JSON.parse(mockSecrets.store.mock.calls[0][1])
			expect(storedConfig.currentApiConfigName).toBe("default")
			expect(Object.keys(storedConfig.apiConfigs)).toEqual(["default"])
			expect(storedConfig.apiConfigs.default.id).toBeTruthy()
		})

		it("should throw error when trying to delete non-existent config", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: {} },
				}),
			)

			await expect(providerSettingsManager.deleteConfig("nonexistent")).rejects.toThrow(
				"Config 'nonexistent' not found",
			)
		})

		it("should throw error when trying to delete last remaining config", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: {
							id: "default",
						},
					},
				}),
			)

			await expect(providerSettingsManager.deleteConfig("default")).rejects.toThrow(
				"Failed to delete config: Error: Cannot delete the last remaining configuration",
			)
		})
	})

	describe("LoadConfig", () => {
		it("should load config and update current config name", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: {
					test: {
						apiProvider: "openai",
						openAiApiKey: "test-key",
						id: "test-id",
					},
				},
				migrations: {
					rateLimitSecondsMigrated: false,
				},
			}

			mockGlobalState.get.mockResolvedValue(42)
			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const { name, ...providerSettings } = await providerSettingsManager.activateProfile({ name: "test" })

			expect(name).toBe("test")
			expect(providerSettings).toEqual({ apiProvider: "openai", openAiApiKey: "test-key", id: "test-id" })

			// Get the stored config to check the structure.
			const calls = mockSecrets.store.mock.calls
			const storedConfig = JSON.parse(calls[calls.length - 1][1])
			expect(storedConfig.currentApiConfigName).toBe("test")

			expect(storedConfig.apiConfigs.test).toEqual({
				apiProvider: "openai",
				openAiApiKey: "test-key",
				id: "test-id",
			})
		})

		it("should throw error when config does not exist", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: { config: {}, id: "default" } },
				}),
			)

			await expect(providerSettingsManager.activateProfile({ name: "nonexistent" })).rejects.toThrow(
				"Config with name 'nonexistent' not found",
			)
		})

		it("should throw error if secrets storage fails", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { test: { apiProvider: "openai", id: "test-id" } },
					migrations: {
						rateLimitSecondsMigrated: true,
					},
				}),
			)
			mockSecrets.store.mockRejectedValue(new Error("Storage failed"))

			await expect(providerSettingsManager.activateProfile({ name: "test" })).rejects.toThrow(
				"Failed to activate profile: Failed to write provider profiles to secrets: Error: Storage failed",
			)
		})

		it("should sanitize unknown providers by resetting apiProvider to undefined", async () => {
			// This tests the fix for the infinite loop issue when a provider is removed
			const configWithUnknownProvider = {
				currentApiConfigName: "valid",
				apiConfigs: {
					valid: {
						apiProvider: "openai",
						openAiApiKey: "valid-key",
						apiModelId: "claude-3-opus-20240229",
						id: "valid-id",
					},
					unknownProvider: {
						// Provider value that is neither active nor retired.
						id: "removed-id",
						apiProvider: "invalid-removed-provider",
						openAiApiKey: "some-key",
						apiModelId: "some-model",
					},
				},
				migrations: {
					rateLimitSecondsMigrated: true,
					consecutiveMistakeLimitMigrated: true,
					todoListEnabledMigrated: true,
				},
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(configWithUnknownProvider))

			await providerSettingsManager.initialize()

			const storeCalls = mockSecrets.store.mock.calls
			expect(storeCalls.length).toBeGreaterThan(0)
			const finalStoredConfigJson = storeCalls[storeCalls.length - 1][1]

			const storedConfig = JSON.parse(finalStoredConfigJson)
			// The valid provider should be untouched
			expect(storedConfig.apiConfigs.valid).toBeDefined()
			expect(storedConfig.apiConfigs.valid.apiProvider).toBe("openai")

			// The config with the unknown provider should have its apiProvider reset to undefined
			// but still be present (not filtered out entirely)
			expect(storedConfig.apiConfigs.unknownProvider).toBeDefined()
			expect(storedConfig.apiConfigs.unknownProvider.apiProvider).toBeUndefined()
			expect(storedConfig.apiConfigs.unknownProvider.id).toBe("removed-id")
		})

		it("should sanitize invalid providers and remove non-object profiles during load", async () => {
			const invalidConfig = {
				currentApiConfigName: "valid",
				apiConfigs: {
					valid: {
						apiProvider: "openai",
						openAiApiKey: "valid-key",
						apiModelId: "claude-3-opus-20240229",
						rateLimitSeconds: 0,
					},
					invalidProvider: {
						// Invalid API provider - should be sanitized (kept but apiProvider reset to undefined)
						id: "x.ai",
						apiProvider: "x.ai",
					},
					// Incorrect type - should be completely removed
					anotherInvalid: "not an object",
				},
				migrations: {
					rateLimitSecondsMigrated: true,
				},
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(invalidConfig))

			await providerSettingsManager.initialize()

			const storeCalls = mockSecrets.store.mock.calls
			expect(storeCalls.length).toBeGreaterThan(0) // Ensure store was called at least once.
			const finalStoredConfigJson = storeCalls[storeCalls.length - 1][1]

			const storedConfig = JSON.parse(finalStoredConfigJson)
			// Valid config should be untouched
			expect(storedConfig.apiConfigs.valid).toBeDefined()
			expect(storedConfig.apiConfigs.valid.apiProvider).toBe("openai")

			// Invalid provider config should be sanitized - kept but apiProvider reset to undefined
			expect(storedConfig.apiConfigs.invalidProvider).toBeDefined()
			expect(storedConfig.apiConfigs.invalidProvider.apiProvider).toBeUndefined()
			expect(storedConfig.apiConfigs.invalidProvider.id).toBe("x.ai")

			// Non-object config should be completely removed
			expect(storedConfig.apiConfigs.anotherInvalid).toBeUndefined()

			expect(Object.keys(storedConfig.apiConfigs)).toEqual(["valid", "invalidProvider"])
			expect(storedConfig.currentApiConfigName).toBe("valid")
		})
	})

	describe("ResetAllConfigs", () => {
		it("should delete all stored configs", async () => {
			// Setup initial config
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "test",
					apiConfigs: { test: { apiProvider: "openai", id: "test-id" } },
				}),
			)

			await providerSettingsManager.resetAllConfigs()

			// Should have called delete with the correct config key
			expect(mockSecrets.delete).toHaveBeenCalledWith("openai_agent_config_api_config")
		})
	})

	describe("HasConfig", () => {
		it("should return true for existing config", async () => {
			const existingConfig: ProviderProfiles = {
				currentApiConfigName: "default",
				apiConfigs: { default: { id: "default" }, test: { apiProvider: "openai", id: "test-id" } },
				migrations: { rateLimitSecondsMigrated: false },
			}

			mockSecrets.get.mockResolvedValue(JSON.stringify(existingConfig))

			const hasConfig = await providerSettingsManager.hasConfig("test")
			expect(hasConfig).toBe(true)
		})

		it("should return false for non-existent config", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({ currentApiConfigName: "default", apiConfigs: { default: {} } }),
			)

			const hasConfig = await providerSettingsManager.hasConfig("nonexistent")
			expect(hasConfig).toBe(false)
		})

		it("should throw error if secrets storage fails", async () => {
			mockSecrets.get.mockRejectedValue(new Error("Storage failed"))

			await expect(providerSettingsManager.hasConfig("test")).rejects.toThrow(
				"Failed to check config existence: Error: Failed to read provider profiles from secrets: Error: Storage failed",
			)
		})
	})

	describe("initialize migration field bootstrap", () => {
		it("creates the migrations field and runs every migration when it is missing", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: { apiProvider: "openai", id: "default" } },
					modeApiConfigs: {},
					// migrations フィールドが無い → 全 false で初期化してから全 migration が走る
				}),
			)

			await providerSettingsManager.initialize()

			const calls = mockSecrets.store.mock.calls
			const stored = JSON.parse(calls[calls.length - 1][1])
			// 初期化後は全 migration が完了フラグ true になる
			expect(stored.migrations).toEqual({
				rateLimitSecondsMigrated: true,
				consecutiveMistakeLimitMigrated: true,
				todoListEnabledMigrated: true,
				claudeCodeLegacySettingsMigrated: true,
			})
		})
	})

	describe("migration helpers (resilience and edge branches)", () => {
		it("migrateRateLimitSeconds falls back to 0 when global state is unavailable", async () => {
			const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {})
			// globalState.get が投げる → 内側 catch でログし、値は既定 0 に落とす
			mockGlobalState.get.mockImplementation(() => {
				throw new Error("global state down")
			})

			const pp = { apiConfigs: { a: {}, b: { rateLimitSeconds: 7 } } }
			await (
				providerSettingsManager as unknown as { migrateRateLimitSeconds(p: unknown): Promise<void> }
			).migrateRateLimitSeconds(pp)

			expect(pp.apiConfigs.a).toEqual({ rateLimitSeconds: 0 })
			// 既存の値は上書きしない
			expect(pp.apiConfigs.b).toEqual({ rateLimitSeconds: 7 })
			expect(consoleErr).toHaveBeenCalled()
			consoleErr.mockRestore()
		})

		it("migrateRateLimitSeconds swallows a malformed profile (outer catch)", async () => {
			const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {})
			await expect(
				(
					providerSettingsManager as unknown as { migrateRateLimitSeconds(p: unknown): Promise<void> }
				).migrateRateLimitSeconds({ apiConfigs: null }),
			).resolves.toBeUndefined()
			expect(consoleErr).toHaveBeenCalled()
			consoleErr.mockRestore()
		})

		it("migrateConsecutiveMistakeLimit swallows a malformed profile (outer catch)", async () => {
			const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {})
			await expect(
				(
					providerSettingsManager as unknown as { migrateConsecutiveMistakeLimit(p: unknown): Promise<void> }
				).migrateConsecutiveMistakeLimit({ apiConfigs: null }),
			).resolves.toBeUndefined()
			expect(consoleErr).toHaveBeenCalled()
			consoleErr.mockRestore()
		})

		it("migrateTodoListEnabled swallows a malformed profile (outer catch)", async () => {
			const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {})
			await expect(
				(
					providerSettingsManager as unknown as { migrateTodoListEnabled(p: unknown): Promise<void> }
				).migrateTodoListEnabled({ apiConfigs: null }),
			).resolves.toBeUndefined()
			expect(consoleErr).toHaveBeenCalled()
			consoleErr.mockRestore()
		})

		it("applyModelMigrations returns false and logs on a malformed profile (outer catch)", async () => {
			const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {})
			const result = (
				providerSettingsManager as unknown as { applyModelMigrations(p: unknown): boolean }
			).applyModelMigrations({ apiConfigs: null })
			expect(result).toBe(false)
			expect(consoleErr).toHaveBeenCalled()
			consoleErr.mockRestore()
		})
	})

	describe("getProfile by id", () => {
		it("returns the profile matched by id", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						default: { id: "default" },
						test: { apiProvider: "openai", id: "test-id" },
					},
				}),
			)

			const profile = await providerSettingsManager.getProfile({ id: "test-id" })
			expect(profile).toEqual({ name: "test", apiProvider: "openai", id: "test-id" })
		})

		it("throws when no profile has the given id", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: { id: "default" } },
				}),
			)

			await expect(providerSettingsManager.getProfile({ id: "missing" })).rejects.toThrow(
				"Config with ID 'missing' not found",
			)
		})

		it("wraps a non-Error rejection from load (getProfile catch, non-Error side)", async () => {
			// コンストラクタの fire-and-forget initialize を先に流し切ってから load を差し替える
			await providerSettingsManager.initialize()
			vi.spyOn(providerSettingsManager as unknown as { load(): Promise<unknown> }, "load").mockRejectedValue(
				"boom-string",
			)

			await expect(providerSettingsManager.getProfile({ name: "x" })).rejects.toThrow(
				"Failed to get profile: boom-string",
			)
		})
	})

	describe("activateProfile non-Error handling", () => {
		it("wraps a non-Error rejection from load (activateProfile catch, non-Error side)", async () => {
			await providerSettingsManager.initialize()
			const validProfiles = {
				currentApiConfigName: "test",
				apiConfigs: { test: { apiProvider: "openai", id: "test-id" } },
				migrations: {},
			}
			// 1 回目(getProfile 内) は成功、2 回目(activateProfile 自身の lock) で非 Error 拒否
			vi.spyOn(providerSettingsManager as unknown as { load(): Promise<unknown> }, "load")
				.mockResolvedValueOnce(validProfiles)
				.mockRejectedValueOnce("boom-string")

			await expect(providerSettingsManager.activateProfile({ name: "test" })).rejects.toThrow(
				"Failed to activate profile: boom-string",
			)
		})
	})

	describe("listConfig model id cleaning", () => {
		it("strips the vendor prefix, keeps plain ids, and tolerates missing model/id", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: {
						withSlash: { apiProvider: "openai", apiModelId: "vendor/model-a", id: "id-a" },
						noSlash: { apiProvider: "openai", apiModelId: "model-b", id: "id-b" },
						noModel: { apiProvider: "openai", id: "id-c" },
						noId: { apiProvider: "openai", apiModelId: "model-d" },
					},
				}),
			)

			const configs = await providerSettingsManager.listConfig()
			const byName = Object.fromEntries(configs.map((c) => [c.name, c]))

			expect(byName.withSlash.modelId).toBe("model-a")
			expect(byName.noSlash.modelId).toBe("model-b")
			expect(byName.noModel.modelId).toBeUndefined()
			// id が無いエントリは "" に落ちる（apiConfig.id || ""）
			expect(byName.noId.id).toBe("")
		})
	})

	describe("setModeConfig / getModeConfigId", () => {
		it("assigns a config id to a mode, creating the mode map when it is absent", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: { id: "default" } },
					// modeApiConfigs 無し → 生成分岐を踏む
				}),
			)

			await providerSettingsManager.setModeConfig("code", "cfg-123")

			const calls = mockSecrets.store.mock.calls
			const stored = JSON.parse(calls[calls.length - 1][1])
			expect(stored.modeApiConfigs.code).toBe("cfg-123")
		})

		it("assigns a config id to a mode when the map already exists (without dropping others)", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: { id: "default" } },
					modeApiConfigs: { code: "old" },
				}),
			)

			await providerSettingsManager.setModeConfig("architect", "cfg-x")

			const calls = mockSecrets.store.mock.calls
			const stored = JSON.parse(calls[calls.length - 1][1])
			expect(stored.modeApiConfigs.architect).toBe("cfg-x")
			expect(stored.modeApiConfigs.code).toBe("old")
		})

		it("throws a wrapped error when storing the mode config fails", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: { id: "default" } },
				}),
			)
			mockSecrets.store.mockRejectedValue(new Error("Storage failed"))

			await expect(providerSettingsManager.setModeConfig("code", "cfg")).rejects.toThrow(
				"Failed to set mode config",
			)
		})

		it("returns the config id configured for a mode", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: { id: "default" } },
					modeApiConfigs: { code: "cfg-123" },
				}),
			)

			expect(await providerSettingsManager.getModeConfigId("code")).toBe("cfg-123")
		})

		it("returns undefined for a mode without a configured id", async () => {
			mockSecrets.get.mockResolvedValue(
				JSON.stringify({
					currentApiConfigName: "default",
					apiConfigs: { default: { id: "default" } },
					// modeApiConfigs 無し → optional chaining が undefined を返す
				}),
			)

			expect(await providerSettingsManager.getModeConfigId("code")).toBeUndefined()
		})

		it("throws a wrapped error when reading the mode config fails", async () => {
			mockSecrets.get.mockRejectedValue(new Error("Read failed"))

			await expect(providerSettingsManager.getModeConfigId("code")).rejects.toThrow("Failed to get mode config")
		})
	})

	describe("export / import error handling", () => {
		it("throws a wrapped error when export cannot read the profiles", async () => {
			mockSecrets.get.mockResolvedValue("not-json") // load 内の JSON.parse が失敗する
			await expect(providerSettingsManager.export()).rejects.toThrow("Failed to export provider profiles")
		})

		it("throws a wrapped error when import cannot store the profiles", async () => {
			mockSecrets.store.mockRejectedValue(new Error("Storage failed"))
			await expect(
				providerSettingsManager.import({
					currentApiConfigName: "default",
					apiConfigs: { default: { id: "default" } },
				} as unknown as ProviderProfiles),
			).rejects.toThrow("Failed to import provider profiles")
		})
	})
})
