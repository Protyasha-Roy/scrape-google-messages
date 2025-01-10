const puppeteer = require('puppeteer');
require('dotenv').config();

class GoogleMessagesScraper {
    constructor() {
        this.browser = null;
        this.page = null;
    }

    async initialize() {
        this.browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--start-maximized']
        });
        this.page = await this.browser.newPage();
        await this.page.setViewport({ width: 1366, height: 768 });
    }

    async waitForElement(selector, timeout = 60000) {
        try {
            await this.page.waitForFunction(
                (selector) => {
                    return document.querySelector(selector) !== null;
                },
                { timeout },
                selector
            );
            return true;
        } catch (error) {
            console.error(`Timeout waiting for element: ${selector}`);
            return false;
        }
    }

    async waitForLogin() {
        // Wait for the QR code to disappear and main content to appear
        await this.page.waitForFunction(
            () => {
                // Check if QR code is gone
                const qrCode = document.querySelector('mw-qr-code');
                if (qrCode) return false;

                // Check if main container is present
                const app = document.querySelector('mw-app');
                if (!app) return false;

                // Check if we're past the loading screen
                const loader = document.querySelector('#loader');
                if (loader && loader.style.display !== 'none') return false;

                return true;
            },
            { timeout: 300000, polling: 1000 } // 5 minutes timeout, check every second
        );
    }

    async login() {
        try {
            console.log('Navigating to Google Messages...');
            await this.page.goto('https://messages.google.com/web', {
                waitUntil: 'networkidle0',
                timeout: 60000
            });

            // Wait for the QR code to appear
            await this.waitForElement('mw-qr-code');
            console.log('Please scan the QR code to login...');

            // Wait for login to complete
            console.log('Waiting for login...');
            await this.waitForLogin();
            
            console.log('Successfully logged in!');

            // Wait for the page to stabilize
            await this.page.waitForTimeout(5000);

            // Wait for conversations container
            await this.page.waitForSelector('div[role="listbox"][aria-label*="Conversations"]', { timeout: 30000 });
        } catch (error) {
            console.error('Login failed:', error.message);
            throw error;
        }
    }

    async getConversations() {
        try {
            console.log('Getting conversations...');
            
            const conversations = await this.page.evaluate(() => {
                // Get the conversations container
                const container = document.querySelector('div[role="listbox"][aria-label*="Conversations"]');
                if (!container) {
                    console.log('No conversations container found');
                    return [];
                }

                // Get all conversation items
                const items = Array.from(container.querySelectorAll('mws-conversation-list-item'));
                console.log(`Found ${items.length} conversation items`);

                return items.map(item => {
                    const nameEl = item.querySelector('[data-e2e-conversation-name]');
                    const snippetEl = item.querySelector('[data-e2e-conversation-snippet] span');
                    const timestampEl = item.querySelector('mws-relative-timestamp');
                    const link = item.querySelector('a[href*="/web/conversations/"]');

                    return {
                        name: nameEl ? nameEl.textContent.trim() : '',
                        lastMessage: snippetEl ? snippetEl.textContent.trim() : '',
                        timestamp: timestampEl ? timestampEl.textContent.trim() : '',
                        id: link ? link.getAttribute('href').split('/').pop() : '',
                        isUnread: item.querySelector('.text-content.unread') !== null
                    };
                }).filter(conv => conv.name);
            });

            console.log(`Found ${conversations.length} conversations:`, conversations);
            return conversations;
        } catch (error) {
            console.error('Error getting conversations:', error);
            return [];
        }
    }

    async getMessagesForConversation(conversation) {
        try {
            console.log(`Opening conversation: ${conversation.name}`);
            
            // Click the conversation using the link
            await this.page.click(`a[href*="/web/conversations/${conversation.id}"]`);
            
            // Wait for messages container to load
            await this.page.waitForSelector('div[data-e2e-messages-list-content]', { timeout: 5000 });
            await this.page.waitForTimeout(2000); // Wait for messages to populate

            // Get messages
            const messages = await this.page.evaluate(() => {
                const allMessages = [];
                
                // Get all message wrappers
                const messageElements = document.querySelectorAll('mws-message-wrapper');
                messageElements.forEach(msg => {
                    const textContainer = msg.querySelector('[data-e2e-text-message-content] .text-msg-content');
                    const messagePartEl = msg.querySelector('mws-text-message-part');
                    const isOutgoing = msg.hasAttribute('is-outgoing') || msg.getAttribute('data-e2e-message-outgoing') === 'true';
                    
                    if (textContainer && messagePartEl) {
                        const messageText = textContainer.textContent.trim();
                        const ariaLabel = messagePartEl.getAttribute('aria-label') || '';
                        
                        // Extract timestamp from aria-label
                        // Format: "sender said: message. Received on Date at Time."
                        let timestamp = '';
                        let date = '';
                        
                        const timeMatch = ariaLabel.match(/Received on (.*?) at (.*?)\./);
                        if (timeMatch) {
                            date = timeMatch[1];
                            timestamp = timeMatch[2];
                        }
                        
                        // Only add non-empty messages
                        if (messageText) {
                            allMessages.push({
                                text: messageText,
                                date,
                                time: timestamp,
                                isOutgoing,
                                isUnread: msg.hasAttribute('is-unread') && msg.getAttribute('is-unread') === 'true'
                            });
                        }
                    }
                });

                return allMessages;
            });

            console.log(`Found ${messages.length} messages in conversation ${conversation.name}`);
            return messages;
        } catch (error) {
            console.error(`Error getting messages for ${conversation.name}:`, error);
            return [];
        }
    }

    async scrapeMessages() {
        try {
            await this.initialize();
            await this.login();
            
            // Wait a bit after login for everything to load
            await this.page.waitForTimeout(5000);
            
            const conversations = await this.getConversations();
            console.log(`Found ${conversations.length} conversations`);
            
            const allMessages = {};
            
            for (const conversation of conversations) {
                console.log(`Scraping messages for ${conversation.name}`);
                const messages = await this.getMessagesForConversation(conversation);
                allMessages[conversation.name] = messages;
                await this.page.waitForTimeout(1000);
            }
            
            return allMessages;
        } catch (error) {
            console.error('Error occurred while scraping:', error);
            throw error;
        } finally {
            if (this.browser) {
                await this.browser.close();
            }
        }
    }
}

async function main() {
    const scraper = new GoogleMessagesScraper();
    try {
        const messages = await scraper.scrapeMessages();
        console.log('Scraped messages:', JSON.stringify(messages, null, 2));
    } catch (error) {
        console.error('Failed to scrape messages:', error);
    }
}

main();
