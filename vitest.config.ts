import { UserConfig, defineConfig, mergeConfig } from "vitest/config";
import electronViteConfig from "./electron.vite.config";

export default mergeConfig(
    electronViteConfig.renderer as UserConfig,
    defineConfig({
        test: {
            reporters: ["verbose", "junit"],
            // A few suites do a dynamic import of the whole preview mock env; on a loaded
            // machine that alone can exceed the 5s default and the run fails for no reason.
            testTimeout: 30000,
            hookTimeout: 30000,
            outputFile: {
                junit: "test-results.xml",
            },
            coverage: {
                provider: "istanbul",
                reporter: ["lcov"],
                reportsDirectory: "./coverage",
            },
            typecheck: {
                tsconfig: "tsconfig.json",
            },
        },
    })
);
