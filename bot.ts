import { Bot, Context, session, MemorySessionStorage } from "https://deno.land/x/grammy@v1.32.0/mod.ts";
import { type ChatMember } from "https://deno.land/x/grammy@v1.32.0/types.ts";
import { chatMembers, type ChatMembersFlavor, } from "https://deno.land/x/grammy_chat_members/mod.ts";
import { type Conversation, type ConversationFlavor, conversations, createConversation } from "https://deno.land/x/grammy_conversations@v1.2.0/mod.ts";
import { getBlockNumber, getElectionBlockBefore, getBlockByNumber, getValidatorByAddress,  getAccountByAddress, getStakerByAddress } from "jsr:@onmax/nimiq-rpc-client-ts@1.0.0-beta.26/http";
import { subscribeForHeadBlock } from "jsr:@onmax/nimiq-rpc-client-ts@1.0.0-beta.26/ws";
import { initRpcClient } from "jsr:@onmax/nimiq-rpc-client-ts@1.0.0-beta.26/client";
import type { Block } from "jsr:@onmax/nimiq-rpc-client-ts@1.0.0-beta.26/types";

import { ValidationUtils, getExchangeRates, FiatCurrency, CryptoCurrency } from "npm:@nimiq/utils";
import "jsr:@std/dotenv/load";

type Kv = {
  key: [number, string];
  value: string;
}

const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
if (!token)
  throw new Error("TELEGRAM_BOT_TOKEN is required.");

initRpcClient({ url: Deno.env.get("NIMIQ_RPC_URL") || "http://localhost:8648" });
const kv = await Deno.openKv("./kv.db");

type MyContext = Context & ConversationFlavor & ChatMembersFlavor;
type MyConversation = Conversation<MyContext>;

const adapter = new MemorySessionStorage<ChatMember>();
const bot = new Bot<MyContext>(token);

bot.use(
  session({
    initial: () => ({}),
  }),
);
bot.use(conversations());
bot.use(chatMembers(adapter));
bot.use(createConversation(addValidator));

async function addValidator(conversation: MyConversation, ctx: MyContext) {
  if (!ctx.chatId) {
    await ctx.reply("This command can only be used in a group chat.");
    return;
  }
  await ctx.reply("What validator address you want to listen to?", { reply_markup: { force_reply: true } });
  const { msg: { text } } = await conversation.waitFor("message:text");
  const isValid = ValidationUtils.isValidAddress(text);
  if (!isValid) {
    await ctx.reply("Invalid address, please try again.");
    return;
  }
  await kv.set([ctx.chatId, "address"], text);
  await ctx.reply(`Listening to ${text}`);
}

bot.command("start", async (ctx) => {
  const chatMember = await ctx.chatMembers.getChatMember(
    ctx.chat.id,
    ctx.from?.id,
  );
  if (ctx.chat.type !== 'private' && chatMember.status !== "creator" && chatMember.status !== "administrator") {
    await ctx.reply("You need to be an admin to use this bot.");
    return;
  }
  await ctx.conversation.enter("addValidator", { overwrite: true });
});

bot.command("validator", async (ctx) => {
  const chatMember = await ctx.chatMembers.getChatMember(
    ctx.chat.id,
    ctx.from?.id,
  );
  if (ctx.chat.type !== 'private' && chatMember.status !== "creator" && chatMember.status !== "administrator") {
    await ctx.reply("You need to be an admin to use this bot.");
    return;
  }
  const address = await kv.get([ctx.chat.id, "address"]);
  if (!address.value) {
    await ctx.reply("No address set. Use /start to set one.");
    return;
  }
  await ctx.reply(`Listening to ${address.value}`);
});

bot.command("status", async (ctx) => {
  const chatId = ctx.chat.id;
  const validator = await kv.get([chatId, "address"]);
  if (!validator.value) {
    await ctx.reply("No address set. Use /start to set one.");
    return;
  }
  
  const [heightSuccess, heightError, height] = await getBlockNumber();
  if (!heightSuccess) {
    console.error(heightError);
    ctx.reply("Unable to get the info right now, please try again later.");
    return;
  }
  
  const [electionSuccess, electionError, electionHeight] = await getElectionBlockBefore({blockNumber:height});
  if (!electionSuccess) {
    console.error(electionError);
    ctx.reply("Unable to get the info right now, please try again later.");
    return;
  }
  
  const [blockSuccess, blockError, electionBlock] = await getBlockByNumber({blockNumber: electionHeight, includeBody: true });
  if (!blockSuccess) {
    console.error(blockError);
    ctx.reply("Unable to get the info right now, please try again later.");
    return;
  }
  await slotsPerValidator(validator.value as string, chatId, electionBlock);
});

bot.command("money", async (ctx) => {
  const chatId = ctx.chat.id;
  const validator = await kv.get([chatId, "address"]);
  if (!validator.value) {
    await ctx.reply("No address set. Use /start to set one.");
    return;
  }
  
  const [success, error, data] = await getValidatorByAddress({address:validator.value as string});
  if (!success) {
    console.error(error);
    ctx.reply("Unable to get the info right now, please try again later.");
    return;
  }
  const { rewardAddress } = data;
  const { USD, NIM, price } = await getRewardsFromValidator(rewardAddress);
  await ctx.reply(`Validator total rewards:\n <b>${NIM} NIM</b>\n <b>${USD} USD</b>\n\n Price:\n <b>${price} NIM/USD</b>`, { parse_mode: "HTML" });
});

bot.command("remove", async (ctx) => {
  const chatMember = await ctx.chatMembers.getChatMember(
    ctx.chat.id,
    ctx.from?.id,
  );
  if (ctx.chat.type !== 'private' && chatMember.status !== "creator" && chatMember.status !== "administrator") {
    await ctx.reply("You need to be an admin to use this bot.");
    return;
  }
  await kv.delete([ctx.chat.id, "address"]);
  await ctx.reply("Address removed.");
});

bot.catch((err) => console.error(err));
bot.start({
  allowed_updates: ["chat_member", "message"],
});

const subscription = await subscribeForHeadBlock();

subscription.addEventListener('data', (event) => {
  const { data: block } = event.detail;
  if (!block || !block.isElectionBlock) return;
  findSlots(block);
});

async function findSlots(block: Block) {
  const validators = (await Array.fromAsync(kv.list({ prefix: [] }))) as unknown as Kv[];

  for (const { key, value } of validators) {
    const [chatId] = key;
    await slotsPerValidator(value, chatId, block);
  }
}

async function slotsPerValidator(address: string, chatId: number, block: Block) {
  if (!('isElectionBlock' in block))
    return;
  if (!block.isElectionBlock)
    return;
  const { slots } = block;

  const assignedSlot = slots.find(slot => slot.validator === address);
  const [success, error, data] = await getValidatorByAddress({address});
  if (!success) {
    console.error(error);
    return;
  }
  
  if (assignedSlot) {
    const { numSlots } = assignedSlot;
    console.log(`Validator ${address} has been assigned ${numSlots} slot${numSlots === 1 ? '' : 's'}.`);
    await bot.api.sendMessage(chatId, `Validator <code>${address}</code> has been assigned <b>${numSlots} slot${numSlots === 1 ? '' : 's'}</b> in epoch ${block.epoch + 1}`, { parse_mode: "HTML" });
  } else {
    console.log(`Validator ${address} has not been assigned any slots.`);
    await bot.api.sendMessage(chatId, `Validator <code>${address}</code> has not been assigned any slots in epoch ${block.epoch + 1} 🥲`, { parse_mode: "HTML" });
  }

  const { rewardAddress } = data;
  const { USD, NIM, price } = await getRewardsFromValidator(rewardAddress);
  console.log(`Validator ${address} has a balance of ${NIM} NIM (${USD} USD)`);
  await bot.api.sendMessage(chatId, `Validator total rewards:\n <b>${NIM} NIM</b>\n <b>${USD} USD</b>\n\n Price:\n <b>${price} NIM/USD</b>`, { parse_mode: "HTML" });
}

async function getRewardsFromValidator(rewardAddress: string) {
  const [accountSuccess, accountError, account] = await getAccountByAddress({ address:rewardAddress });
  // If rewardAddress is the same as the validator address, this will fail, ignore it
  const [_, __, staker] = await getStakerByAddress({ address:rewardAddress });
  
  if (!accountSuccess) {
    console.error({ accountError });
    return { USD: 0, NIM: 0, price: 0 };
  }
  
  const balance = (account.balance + (staker?.balance || 0)) / 1e5;
  const NIM = Math.round(balance * 100) / 100;
  
  const { nim: { usd: price } } = await getExchangeRates([CryptoCurrency.NIM], [FiatCurrency.USD]);
  if (!price)
    return { USD: 0, NIM, price: 0 };

  const USD = Math.round((balance * price + Number.EPSILON) * 100) / 100;

  return { USD, NIM, price };
}
