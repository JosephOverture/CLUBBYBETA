import type { Database } from '../platform/database';
import type { OrganizationsService } from '../organizations/organizations.service';
import { StripeProvider, type PaymentProvider } from './provider';
import { OrdersService } from './orders.service';
import { InventoryService } from './inventory.service';
import { SellersService } from './sellers.service';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';
import { AdmissionsService } from './admissions.service';
import { BookingSupportService } from './support.service';
import { BillingService } from './billing.service';
import { TablesService } from '../tables/tables.service';
import { GroupsService } from '../groups/groups.service';
import { ChatService } from '../groups/chat.service';
import { TransfersService } from '../tickets/transfers.service';
import { WalletService } from '../tickets/wallet.service';
import type { WalletProvider } from '../tickets/wallet-provider';
import { SavedMethodsService } from './saved-methods.service';
export function commerceServices(
  db: Database,
  organizations: OrganizationsService,
  provider: PaymentProvider = new StripeProvider(db.config),
  walletProvider?: WalletProvider,
) {
  const orders = new OrdersService(db, organizations, provider),
    sellers = new SellersService(db, organizations, provider),
    refunds = new RefundsService(db, organizations, orders, provider);
  const payments = new PaymentsService(db, provider, orders, refunds, sellers),
    inventory = new InventoryService(db, organizations),
    admissions = new AdmissionsService(db, organizations, orders),
    support = new BookingSupportService(db, organizations, orders, refunds);
  const billing = new BillingService(db, organizations, orders);
  const transfers = new TransfersService(db, organizations, orders);
  const wallet = new WalletService(db, transfers, walletProvider);
  const tables = new TablesService(db, organizations, orders),
    groups = new GroupsService(db, organizations, orders, refunds, tables),
    chat = new ChatService(db, groups, organizations);
  return {
    orders,
    sellers,
    refunds,
    payments,
    inventory,
    admissions,
    support,
    billing,
    tables,
    groups,
    chat,
    transfers,
    wallet,
    savedMethods: orders.savedMethods,
    providers: [
      { provide: OrdersService, useValue: orders },
      { provide: SellersService, useValue: sellers },
      { provide: RefundsService, useValue: refunds },
      { provide: PaymentsService, useValue: payments },
      { provide: InventoryService, useValue: inventory },
      { provide: AdmissionsService, useValue: admissions },
      { provide: BookingSupportService, useValue: support },
      { provide: BillingService, useValue: billing },
      { provide: TablesService, useValue: tables },
      { provide: GroupsService, useValue: groups },
      { provide: ChatService, useValue: chat },
      { provide: TransfersService, useValue: transfers },
      { provide: WalletService, useValue: wallet },
      { provide: SavedMethodsService, useValue: orders.savedMethods },
    ],
  };
}
