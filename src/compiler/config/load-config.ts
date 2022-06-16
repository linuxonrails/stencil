import type {
  CompilerSystem,
  Diagnostic,
  LoadConfigInit,
  LoadConfigResults,
  UnvalidatedConfig,
} from '../../declarations';
import { buildError, catchError, hasError, isString, normalizePath } from '@utils';
import { createLogger } from '../sys/logger/console-logger';
import { createSystem } from '../sys/stencil-sys';
import { dirname } from 'path';
import { IS_NODE_ENV } from '../sys/environment';
import { nodeRequire } from '../sys/node-require';
import { validateConfig } from './validate-config';
import { validateTsConfig } from '../sys/typescript/typescript-config';
import ts from 'typescript';

/**
 * Load and validate a configuration to use throughout the lifetime of any Stencil task (build, test, etc.).
 *
 * Users can provide configurations multiple ways simultaneously:
 * - as an object of the `init` argument to this function
 * - through a path to a configuration file that exists on disk
 *
 * In the case of both being present, the two configurations will be merged. The fields of the former will take precedence
 * over the fields of the latter.
 *
 * @param init the initial configuration provided by the user (or generated by Stencil) used to bootstrap configuration
 * loading and validation
 * @returns the results of loading a configuration
 * @public
 */
export const loadConfig = async (init: LoadConfigInit = {}): Promise<LoadConfigResults> => {
  const results: LoadConfigResults = {
    config: null,
    diagnostics: [],
    tsconfig: {
      path: null,
      compilerOptions: null,
      files: null,
      include: null,
      exclude: null,
      extends: null,
    },
  };

  const unknownConfig: UnvalidatedConfig = {};

  try {
    const sys = init.sys || createSystem();
    const config = init.config || {};
    let configPath = init.configPath || config.configPath;

    const loadedConfigFile = await loadConfigFile(sys, results.diagnostics, configPath);
    if (hasError(results.diagnostics)) {
      return results;
    }

    if (loadedConfigFile !== null) {
      // merge the user's config object into their loaded config file
      configPath = loadedConfigFile.configPath;
      unknownConfig.config = { ...loadedConfigFile, ...config };
      unknownConfig.config.configPath = configPath;
      unknownConfig.config.rootDir = normalizePath(dirname(configPath));
    } else {
      // no stencil.config.ts or .js file, which is fine
      unknownConfig.config = { ...config };
      unknownConfig.config.configPath = null;
      unknownConfig.config.rootDir = normalizePath(sys.getCurrentDirectory());
    }

    unknownConfig.config.sys = sys;

    const validated = validateConfig(unknownConfig.config);
    results.diagnostics.push(...validated.diagnostics);
    if (hasError(results.diagnostics)) {
      return results;
    }

    results.config = validated.config;

    if (results.config.flags.debug || results.config.flags.verbose) {
      results.config.logLevel = 'debug';
    } else if (results.config.flags.logLevel) {
      results.config.logLevel = results.config.flags.logLevel;
    } else if (typeof results.config.logLevel !== 'string') {
      results.config.logLevel = 'info';
    }

    results.config.logger = init.logger || results.config.logger || createLogger();
    results.config.logger.setLevel(results.config.logLevel);

    if (!hasError(results.diagnostics)) {
      const tsConfigResults = await validateTsConfig(results.config, sys, init);
      results.diagnostics.push(...tsConfigResults.diagnostics);

      results.config.tsconfig = tsConfigResults.path;
      results.config.tsCompilerOptions = tsConfigResults.compilerOptions;

      results.tsconfig.path = tsConfigResults.path;
      results.tsconfig.compilerOptions = JSON.parse(JSON.stringify(tsConfigResults.compilerOptions));
      results.tsconfig.files = tsConfigResults.files;
      results.tsconfig.include = tsConfigResults.include;
      results.tsconfig.exclude = tsConfigResults.exclude;
      results.tsconfig.extends = tsConfigResults.extends;
    }
  } catch (e: any) {
    catchError(results.diagnostics, e);
  }

  return results;
};

/**
 * Load a Stencil configuration file from disk
 * @param sys the underlying System entity to use to interact with the operating system
 * @param diagnostics a series of diagnostics used to track errors & warnings throughout the loading process. Entries
 * may be added to this list in the event of an error.
 * @param configPath the path to the configuration file to load
 * @returns an unvalidated configuration. In the event of an error, additional diagnostics may be pushed to the
 * provided `diagnostics` argument and `null` will be returned.
 */
const loadConfigFile = async (
  sys: CompilerSystem,
  diagnostics: Diagnostic[],
  configPath: string
): Promise<UnvalidatedConfig | null> => {
  let config: UnvalidatedConfig | null = null;

  if (isString(configPath)) {
    // the passed in config was a string, so it's probably a path to the config we need to load
    const configFileData = await evaluateConfigFile(sys, diagnostics, configPath);
    if (hasError(diagnostics)) {
      return config;
    }

    if (!configFileData.config) {
      const err = buildError(diagnostics);
      err.messageText = `Invalid Stencil configuration file "${configPath}". Missing "config" property.`;
      err.absFilePath = configPath;
      return config;
    }
    config = configFileData.config;
    config.configPath = normalizePath(configPath);
  }

  return config;
};

/**
 * Load the configuration file, based on the environment that Stencil is being run in
 * @param sys the underlying System entity to use to interact with the operating system
 * @param diagnostics a series of diagnostics used to track errors & warnings throughout the loading process. Entries
 * may be added to this list in the event of an error.
 * @param configFilePath the path to the configuration file to load
 * @returns an unvalidated configuration. In the event of an error, additional diagnostics may be pushed to the
 * provided `diagnostics` argument and `null` will be returned.
 */
const evaluateConfigFile = async (
  sys: CompilerSystem,
  diagnostics: Diagnostic[],
  configFilePath: string
): Promise<{ config?: UnvalidatedConfig } | null> => {
  let configFileData: { config?: UnvalidatedConfig } | null = null;

  try {
    if (IS_NODE_ENV) {
      const results = nodeRequire(configFilePath);
      diagnostics.push(...results.diagnostics);
      configFileData = results.module;
    } else {
      // browser environment, can't use node's require() to evaluate
      let sourceText = await sys.readFile(configFilePath);
      sourceText = transpileTypedConfig(diagnostics, sourceText, configFilePath);
      if (hasError(diagnostics)) {
        return configFileData;
      }

      const evalConfig = new Function(`const exports = {}; ${sourceText}; return exports;`);
      configFileData = evalConfig();
    }
  } catch (e: any) {
    catchError(diagnostics, e);
  }

  return configFileData;
};

/**
 * Transpiles the provided TypeScript source text into JavaScript.
 *
 * This function is intended to be used on a `stencil.config.ts` file
 *
 * @param diagnostics a collection of compiler diagnostics to check as a part of the compilation process
 * @param sourceText the text to transpile
 * @param filePath the name of the file to transpile
 * @returns the transpiled text. If there are any diagnostics in the provided collection, the provided source is returned
 */
const transpileTypedConfig = (diagnostics: Diagnostic[], sourceText: string, filePath: string): string => {
  // let's transpile an awesome stencil.config.ts file into
  // a boring stencil.config.js file
  if (hasError(diagnostics)) {
    return sourceText;
  }

  const opts: ts.TranspileOptions = {
    fileName: filePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      target: ts.ScriptTarget.ES2015,
      allowJs: true,
    },
    reportDiagnostics: false,
  };

  const output = ts.transpileModule(sourceText, opts);

  return output.outputText;
};
