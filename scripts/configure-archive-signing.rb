#!/usr/bin/env ruby
# One-shot: flip Release configs on main app + widget to their Distribution
# profiles for archiving. Run on Mac Mini BEFORE xcodebuild archive. The
# add-widget-target.rb script resets widget Release to Development on every
# repo sync, so this stays opt-in for release builds.

require 'xcodeproj'

project_path = File.expand_path(File.join(__dir__, '..', 'ios', 'PearCal.xcodeproj'))
project = Xcodeproj::Project.open(project_path)

TEAM_ID = 'G79ALD29NA'
MAPPINGS = {
  'PearCal'       => 'PearCal Distribution',
  'PearCalWidget' => 'PearCal Widget Distribution',
}

MAPPINGS.each do |target_name, profile_name|
  t = project.targets.find { |x| x.name == target_name }
  raise "target #{target_name} not found" unless t
  cfg = t.build_configurations.find { |c| c.name == 'Release' }
  s = cfg.build_settings
  s['CODE_SIGN_STYLE']                = 'Manual'
  s['DEVELOPMENT_TEAM']               = TEAM_ID
  s['CODE_SIGN_IDENTITY']             = 'Apple Distribution'
  s['PROVISIONING_PROFILE_SPECIFIER'] = profile_name
  puts "#{target_name} Release -> #{profile_name}"
end

project.save
puts 'project.pbxproj saved'
