#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PearCalNotifications, NSObject)
RCT_EXTERN_METHOD(schedule:(NSDictionary *)opts
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(cancel:(NSNumber *)notifId
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(postNow:(NSDictionary *)opts
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getPermission:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
@end
