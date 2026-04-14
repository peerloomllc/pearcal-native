#!/usr/bin/env ruby
# Create PearCalWidget extension target (idempotent) and register main-app WidgetCache module sources.
# Run on Mac Mini: ruby scripts/add-widget-target.rb

require 'xcodeproj'

ROOT = File.expand_path(File.join(__dir__, '..'))
PROJECT_PATH = File.join(ROOT, 'ios', 'PearCal.xcodeproj')
project = Xcodeproj::Project.open(PROJECT_PATH)

app_target = project.targets.find { |t| t.name == 'PearCal' }
raise 'PearCal target not found' unless app_target

# --- 1. Register WidgetCacheModule.{swift,m} into the main target -------------

main_group = project.main_group.find_subpath('PearCal', true)

WIDGET_SOURCES = %w[WidgetCacheModule.swift WidgetCacheModule.m].freeze

# Purge every trace of these sources so we can re-add cleanly. Prior revisions
# of this script leaked duplicate file references, group entries, and build
# files on repeat runs; this pass normalizes the project even when re-run
# against a dirty pbxproj.
WIDGET_SOURCES.each do |basename|
  app_target.source_build_phase.files.dup.each do |bf|
    next unless bf.file_ref && (bf.file_ref.path == basename || bf.file_ref.path&.end_with?("/#{basename}"))
    app_target.source_build_phase.remove_build_file(bf)
  end
  project.files.dup.each do |fr|
    next unless fr.path == basename || fr.path == "PearCal/#{basename}"
    fr.remove_from_project
  end
end

WIDGET_SOURCES.each do |basename|
  ref = main_group.new_file(File.join(ROOT, 'ios', 'PearCal', basename))
  app_target.source_build_phase.add_file_reference(ref)
  puts "add   #{basename} -> PearCal target"
end

# --- 2. Widget extension target ----------------------------------------------

WIDGET_TARGET_NAME = 'PearCalWidget'
WIDGET_BUNDLE_ID   = 'com.pearcal.widget'
TEAM_ID            = 'G79ALD29NA'
DEV_PROFILE        = 'PearCal Widget Development'
DIST_PROFILE       = 'PearCal Widget Distribution'

widget_target = project.targets.find { |t| t.name == WIDGET_TARGET_NAME }

if widget_target.nil?
  widget_target = project.new_target(
    :app_extension,
    WIDGET_TARGET_NAME,
    :ios,
    '15.1',
    nil,
    :swift
  )
  puts "add   target #{WIDGET_TARGET_NAME}"
else
  puts "skip  target #{WIDGET_TARGET_NAME} (exists)"
end

# Widget group & source file
widget_group = project.main_group.find_subpath(WIDGET_TARGET_NAME, true)
widget_group.set_path(WIDGET_TARGET_NAME)

swift_basename = 'PearCalWidget.swift'
unless widget_group.files.any? { |f| f.path == swift_basename }
  ref = widget_group.new_file(File.join(ROOT, 'ios', WIDGET_TARGET_NAME, swift_basename))
  widget_target.source_build_phase.add_file_reference(ref)
  puts "add   #{swift_basename} -> widget target"
end

# Info.plist + entitlements are referenced via build settings (no need to add to build phases)

# --- 3. Widget build settings ------------------------------------------------

widget_target.build_configurations.each do |cfg|
  is_debug = cfg.name == 'Debug'
  s = cfg.build_settings
  s['PRODUCT_NAME']                    = WIDGET_TARGET_NAME
  s['PRODUCT_BUNDLE_IDENTIFIER']       = WIDGET_BUNDLE_ID
  s['INFOPLIST_FILE']                  = "#{WIDGET_TARGET_NAME}/Info.plist"
  s['CODE_SIGN_ENTITLEMENTS']          = "#{WIDGET_TARGET_NAME}/PearCalWidget.entitlements"
  s['IPHONEOS_DEPLOYMENT_TARGET']      = '15.1'
  s['SWIFT_VERSION']                   = '5.0'
  s['TARGETED_DEVICE_FAMILY']          = '1,2'
  s['MARKETING_VERSION']               = '1.0.17'
  s['CURRENT_PROJECT_VERSION']         = '12'
  s['SKIP_INSTALL']                    = 'NO'
  s['LD_RUNPATH_SEARCH_PATHS']         = '$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks'
  s['CODE_SIGN_STYLE']                 = 'Manual'
  s['DEVELOPMENT_TEAM']                = TEAM_ID
  # Match main-app local build flow: Release also signs with Development profile
  # for on-device installs. App Store archive overrides via xcodebuild flags.
  s['CODE_SIGN_IDENTITY']              = 'Apple Development'
  s['PROVISIONING_PROFILE_SPECIFIER']  = DEV_PROFILE
  s['ASSETCATALOG_COMPILER_WIDGET_BACKGROUND_COLOR_NAME'] = 'WidgetBackground'
  s['ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES'] = 'YES'
end

# Make sure main target also has manual signing settings for widget-compatibility --
# (We do not change existing main-target signing beyond ensuring DEVELOPMENT_TEAM is set.)

# --- 4. Embed extension into main app ----------------------------------------

embed_phase = app_target.copy_files_build_phases.find { |p| p.name == 'Embed App Extensions' }
if embed_phase.nil?
  embed_phase = app_target.new_copy_files_build_phase('Embed App Extensions')
  embed_phase.symbol_dst_subfolder_spec = :plug_ins
  puts 'add   Embed App Extensions phase'
end

unless embed_phase.files_references.map(&:path).include?("#{WIDGET_TARGET_NAME}.appex")
  product_ref = widget_target.product_reference
  bf = embed_phase.add_file_reference(product_ref, true)
  bf.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
  puts 'add   widget product to embed phase'
end

# Add widget target as dependency of main app
unless app_target.dependencies.any? { |d| d.target == widget_target }
  app_target.add_dependency(widget_target)
  puts 'add   widget target dependency'
end

project.save
puts 'project.pbxproj saved'
