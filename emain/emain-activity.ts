// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// for activity updates
let wasActive = true;
let wasInFg = true;
let globalIsQuitting = false;
let globalIsStarting = true;
let globalIsRelaunching = false;
let forceQuit = false;
let userConfirmedQuit = false;
let runningSessionNames: string[] = [];
let termCommandsRun = 0;
let termCommandsRemote = 0;
let termCommandsWsl = 0;
let termCommandsDurable = 0;

export function setWasActive(val: boolean) {
    wasActive = val;
}

export function setWasInFg(val: boolean) {
    wasInFg = val;
}

export function getActivityState(): { wasActive: boolean; wasInFg: boolean } {
    return { wasActive, wasInFg };
}

export function setGlobalIsQuitting(val: boolean) {
    globalIsQuitting = val;
}

export function getGlobalIsQuitting(): boolean {
    return globalIsQuitting;
}

export function setGlobalIsStarting(val: boolean) {
    globalIsStarting = val;
}

export function getGlobalIsStarting(): boolean {
    return globalIsStarting;
}

export function setGlobalIsRelaunching(val: boolean) {
    globalIsRelaunching = val;
}

export function getGlobalIsRelaunching(): boolean {
    return globalIsRelaunching;
}

export function setForceQuit(val: boolean) {
    forceQuit = val;
}

export function getForceQuit(): boolean {
    return forceQuit;
}

// Names of agent sessions that are mid-turn (working) or live as background agents,
// pushed up from the renderer's sidebar. Used to warn before quitting — the process
// dies with the app, so a running turn would be cut off.
export function setRunningSessionNames(names: string[]) {
    runningSessionNames = Array.isArray(names) ? names : [];
}

export function getRunningSessionNames(): string[] {
    return runningSessionNames;
}

export function setUserConfirmedQuit(val: boolean) {
    userConfirmedQuit = val;
}

export function getUserConfirmedQuit(): boolean {
    return userConfirmedQuit;
}

export function incrementTermCommandsRun() {
    termCommandsRun++;
}

export function getAndClearTermCommandsRun(): number {
    const count = termCommandsRun;
    termCommandsRun = 0;
    return count;
}

export function incrementTermCommandsRemote() {
    termCommandsRemote++;
}

export function getAndClearTermCommandsRemote(): number {
    const count = termCommandsRemote;
    termCommandsRemote = 0;
    return count;
}

export function incrementTermCommandsWsl() {
    termCommandsWsl++;
}

export function getAndClearTermCommandsWsl(): number {
    const count = termCommandsWsl;
    termCommandsWsl = 0;
    return count;
}

export function incrementTermCommandsDurable() {
    termCommandsDurable++;
}

export function getAndClearTermCommandsDurable(): number {
    const count = termCommandsDurable;
    termCommandsDurable = 0;
    return count;
}
