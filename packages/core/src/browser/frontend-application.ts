/********************************************************************************
 * Copyright (C) 2017 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { inject, injectable, named } from 'inversify';
import { ContributionProvider, CommandRegistry, MenuModelRegistry, ILogger, isOSX } from '../common';
import { MaybePromise } from '../common/types';
import { KeybindingRegistry } from './keybinding';
import { Widget } from './widgets';
import { ApplicationShell } from './shell/application-shell';
import { ShellLayoutRestorer } from './shell/shell-layout-restorer';
import { FrontendApplicationStateService } from './frontend-application-state';
import { preventNavigation, parseCssTime } from './browser';
import { CorePreferences } from './core-preferences';

/**
 * Clients can implement to get a callback for contributing widgets to a shell on start.
 */
export const FrontendApplicationContribution = Symbol('FrontendApplicationContribution');
export interface FrontendApplicationContribution {

    /**
     * Called on application startup before onStart is called.
     */
    initialize?(): void;

    /**
     * Called when the application is started. The application shell is not attached yet when this method runs.
     * Should return a promise if it runs asynchronously.
     */
    onStart?(app: FrontendApplication): MaybePromise<void>;

    /**
     * Called on `beforeunload` event, right before the window closes.
     * Return `true` in order to prevent exit.
     * Note: No async code allowed, this function has to run on one tick.
     */
    onWillStop?(app: FrontendApplication): boolean | void;

    /**
     * Called when an application is stopped or unloaded.
     *
     * Note that this is implemented using `window.unload` which doesn't allow any asynchronous code anymore.
     * I.e. this is the last tick.
     */
    onStop?(app: FrontendApplication): void;

    /**
     * Called after the application shell has been attached in case there is no previous workbench layout state.
     * Should return a promise if it runs asynchronously.
     */
    initializeLayout?(app: FrontendApplication): MaybePromise<void>;
}

/**
 * Default frontend contribution that can be extended by clients if they do not want to implement any of the
 * methods from the interface but still want to contribute to the frontend application.
 */
@injectable()
export abstract class DefaultFrontendApplicationContribution implements FrontendApplicationContribution {

    initialize() {
        // NOOP
    }

}

@injectable()
export class FrontendApplication {

    @inject(CorePreferences)
    protected readonly corePreferences: CorePreferences;

    constructor(
        @inject(CommandRegistry) protected readonly commands: CommandRegistry,
        @inject(MenuModelRegistry) protected readonly menus: MenuModelRegistry,
        @inject(KeybindingRegistry) protected readonly keybindings: KeybindingRegistry,
        @inject(ILogger) protected readonly logger: ILogger,
        @inject(ShellLayoutRestorer) protected readonly layoutRestorer: ShellLayoutRestorer,
        @inject(ContributionProvider) @named(FrontendApplicationContribution)
        protected readonly contributions: ContributionProvider<FrontendApplicationContribution>,
        @inject(ApplicationShell) protected readonly _shell: ApplicationShell,
        @inject(FrontendApplicationStateService) protected readonly stateService: FrontendApplicationStateService
    ) { }

    get shell(): ApplicationShell {
        return this._shell;
    }

    /**
     * Start the frontend application.
     *
     * Start up consists of the following steps:
     * - start frontend contributions
     * - attach the application shell to the host element
     * - initialize the application shell layout
     * - reveal the application shell if it was hidden by a startup indicator
     */
    async start(): Promise<void> {
        await this.startContributions();
        this.stateService.state = 'started_contributions';

        const host = await this.getHost();
        this.attachShell(host);
        await new Promise(resolve => requestAnimationFrame(() => resolve()));
        this.stateService.state = 'attached_shell';

        await this.initializeLayout();
        this.stateService.state = 'initialized_layout';

        await this.revealShell(host);
        this.registerEventListeners();
        this.stateService.state = 'ready';
    }

    /**
     * Return a promise to the host element to which the application shell is attached.
     */
    protected getHost(): Promise<HTMLElement> {
        if (document.body) {
            return Promise.resolve(document.body);
        }
        return new Promise<HTMLElement>(resolve =>
            window.addEventListener('load', () => resolve(document.body), { once: true })
        );
    }

    /**
     * Return an HTML element that indicates the startup phase, e.g. with an animation or a splash screen.
     */
    protected getStartupIndicator(host: HTMLElement): HTMLElement | undefined {
        const startupElements = host.getElementsByClassName('theia-preload');
        return startupElements.length === 0 ? undefined : startupElements[0] as HTMLElement;
    }

    /**
     * Register global event listeners.
     */
    protected registerEventListeners(): void {
        window.addEventListener('beforeunload', event => {
            if (this.preventStop()) {
                event.returnValue = '';
                event.preventDefault();
                return '';
            }
        });
        window.addEventListener('unload', () => {
            this.stateService.state = 'closing_window';
            this.layoutRestorer.storeLayout(this);
            this.stopContributions();
        });
        window.addEventListener('resize', () => this.shell.update());
        document.addEventListener('keydown', event => this.keybindings.run(event), true);
        // Prevent forward/back navigation by scrolling in OS X
        if (isOSX) {
            document.body.addEventListener('wheel', preventNavigation);
        }
    }

    /**
     * Attach the application shell to the host element. If a startup indicator is present, the shell is
     * inserted before that indicator so it is not visible yet.
     */
    protected attachShell(host: HTMLElement): void {
        const ref = this.getStartupIndicator(host);
        Widget.attach(this.shell, host, ref);
    }

    /**
     * If a startup indicator is present, it is first hidden with the `theia-hidden` CSS class and then
     * removed after a while. The delay until removal is taken from the CSS transition duration.
     */
    protected revealShell(host: HTMLElement): Promise<void> {
        const startupElem = this.getStartupIndicator(host);
        if (startupElem) {
            return new Promise(resolve => {
                window.requestAnimationFrame(() => {
                    startupElem.classList.add('theia-hidden');
                    const preloadStyle = window.getComputedStyle(startupElem);
                    const transitionDuration = parseCssTime(preloadStyle.transitionDuration, 0);
                    window.setTimeout(() => {
                        const parent = startupElem.parentElement;
                        if (parent) {
                            parent.removeChild(startupElem);
                        }
                        resolve();
                    }, transitionDuration);
                });
            });
        } else {
            return Promise.resolve();
        }
    }

    /**
     * Initialize the shell layout either using the layout restorer service or, if no layout has
     * been stored, by creating the default layout.
     */
    protected async initializeLayout(): Promise<void> {
        if (!await this.restoreLayout()) {
            // Fallback: Create the default shell layout
            await this.createDefaultLayout();
        }
        await this.shell.pendingUpdates;
    }

    /**
     * Try to restore the shell layout from the storage service. Resolves to `true` if successful.
     */
    protected async restoreLayout(): Promise<boolean> {
        try {
            return await this.layoutRestorer.restoreLayout(this);
        } catch (error) {
            this.logger.error('Could not restore layout', error);
            return false;
        }
    }

    /**
     * Let the frontend application contributions initialize the shell layout. Override this
     * method in order to create an application-specific custom layout.
     */
    protected async createDefaultLayout(): Promise<void> {
        for (const contribution of this.contributions.getContributions()) {
            if (contribution.initializeLayout) {
                await this.measure(contribution.constructor.name + '.initializeLayout',
                    () => contribution.initializeLayout!(this)
                );
            }
        }
    }

    /**
     * `beforeunload` listener implementation
     */
    protected preventStop(): boolean {
        const confirmExit = this.corePreferences['application.confirmExit'];
        if (confirmExit === 'never') {
            return false;
        }
        for (const contribution of this.contributions.getContributions()) {
            if (contribution.onWillStop) {
                return !!contribution.onWillStop(this);
            }
        }
        return confirmExit === 'always';
    }

    /**
     * Initialize and start the frontend application contributions.
     */
    protected async startContributions(): Promise<void> {
        for (const contribution of this.contributions.getContributions()) {
            if (contribution.initialize) {
                try {
                    contribution.initialize();
                } catch (error) {
                    this.logger.error('Could not initialize contribution', error);
                }
            }
        }

        /**
         * FIXME:
         * - decouple commands & menus
         * - consider treat commands, keybindings and menus as frontend application contributions
         */
        this.commands.onStart();
        this.keybindings.onStart();
        this.menus.onStart();
        for (const contribution of this.contributions.getContributions()) {
            if (contribution.onStart) {
                try {
                    await this.measure(contribution.constructor.name + '.onStart',
                        () => contribution.onStart!(this)
                    );
                } catch (error) {
                    this.logger.error('Could not start contribution', error);
                }
            }
        }
    }

    /**
     * Stop the frontend application contributions. This is called when the window is unloaded.
     */
    protected stopContributions(): void {
        for (const contribution of this.contributions.getContributions()) {
            if (contribution.onStop) {
                try {
                    contribution.onStop(this);
                } catch (error) {
                    this.logger.error('Could not stop contribution', error);
                }
            }
        }
    }

    protected async measure<T>(name: string, fn: () => MaybePromise<T>): Promise<T> {
        const startMark = name + '-start';
        const endMark = name + '-end';
        performance.mark(startMark);
        const result = await fn();
        performance.mark(endMark);
        performance.measure(name, startMark, endMark);
        for (const item of performance.getEntriesByName(name)) {
            if (item.duration > 100) {
                console.warn(item.name + ' is slow, took: ' + item.duration + ' ms');
            } else {
                console.debug(item.name + ' took ' + item.duration + ' ms');
            }
        }
        performance.clearMeasures(name);
        return result;
    }

}
